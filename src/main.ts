import * as core from "@actions/core";
import * as github from "@actions/github";
import {Context} from "@actions/github/lib/context"
// @ts-ignore
import {sync as commitParser} from "conventional-commits-parser"
import {octokitLogger, parseGitTagRef} from "./utils"
import {GitHub} from "@actions/github/lib/utils"
import {components} from "@octokit/openapi-types"
import semverValid from "semver/functions/valid"
import semverRcompare from "semver/functions/rcompare"
import semverLt from "semver/functions/lt"
import {generateChangelogFromParsedCommits, getChangelogOptions, isBreakingChange, ParsedCommits} from "./changelog"

type Arguments = {
    token: string;
    draft: boolean;
    preRelease: boolean;
    title: string;
    files: string[];
}

function parseArguments(): Arguments {
    const token = core.getInput("token", { required: true })
    const draft = core.getBooleanInput("draft")
    const preRelease = core.getBooleanInput("pre-release")
    const title = core.getInput("title")
    const files = core.getMultilineInput("files")
    return { token, draft, preRelease, title, files};
}

const searchForPreviousReleaseTag = async (
    client: InstanceType<typeof GitHub>,
    currentReleaseTag: string,
    tagInfo: { owner: string, repo: string },
): Promise<string> => {
    const validSemver = semverValid(currentReleaseTag);
    if (!validSemver) {
        throw new Error(
            `The parameter "automatic_release_tag" was not set and the current tag "${currentReleaseTag}" does not appear to conform to semantic versioning.`,
        );
    }

    const listTagsOptions = client.rest.repos.listTags.endpoint.merge(tagInfo);
    const tl = await client.paginate(listTagsOptions);

    const tagList = tl
        .map((tag: any) => {
            core.debug(`Currently processing tag ${tag.name}`);
            const t = semverValid(tag.name);
            return {
                ...tag,
                semverTag: t,
            };
        })
        .filter((tag) => tag.semverTag !== null)
        .sort((a, b) => semverRcompare(a.semverTag, b.semverTag));

    let previousReleaseTag = '';
    for (const tag of tagList) {
        if (semverLt(tag.semverTag, currentReleaseTag)) {
            previousReleaseTag = tag.name;
            break;
        }
    }

    return previousReleaseTag;
};

const getCommitsSinceRelease = async (
    client: InstanceType<typeof GitHub>,
    tagInfo: { owner: string, repo: string, ref: string },
    currentSha: string,
): Promise<components["schemas"]["commit"][]> => {
    core.startGroup('Retrieving commit history');

    core.info('Determining state of the previous release');
    let previousReleaseRef = '' as string;
    core.info(`Searching for SHA corresponding to previous "${tagInfo.ref}" release tag`);
    try {
        const resp = await client.rest.git.getRef(tagInfo);
        previousReleaseRef = parseGitTagRef(tagInfo.ref);
    } catch (err) {
        core.info(
            `Could not find SHA corresponding to tag "${tagInfo.ref}" (${(err as Error).message}). Assuming this is the first release.`,
        );
        previousReleaseRef = 'HEAD';
    }

    core.info(`Retrieving commits between ${previousReleaseRef} and ${currentSha}`);
    let commits: components["schemas"]["commit"][] = [];
    try {
        const resp = await client.rest.repos.compareCommits({
            owner: tagInfo.owner,
            repo: tagInfo.repo,
            base: previousReleaseRef,
            head: currentSha,
        });
        core.info(
            `Successfully retrieved ${resp.data.commits.length} commits between ${previousReleaseRef} and ${currentSha}`,
        );
        commits = resp.data.commits;

    } catch (err) {
        // istanbul ignore next
        core.warning(`Could not find any commits between ${previousReleaseRef} and ${currentSha}`);
    }
    core.debug(`Currently ${commits.length} number of commits between ${previousReleaseRef} and ${currentSha}`);

    core.endGroup();
    return commits;
};

export const getChangelog = async (
    client: InstanceType<typeof GitHub>,
    owner: string,
    repo: string,
    commits: components["schemas"]["commit"][],
): Promise<string> => {
    const parsedCommits: ParsedCommits[] = [];
    core.startGroup('Generating changelog');

    const issues = (await client.rest.issues.listEventsForRepo({
        owner: owner,
        repo: repo
    })).data.filter(issue => issue.commit_id && issue.commit_url)

    for (const commit of commits) {
        core.debug(`Processing commit: ${JSON.stringify(commit)}`);
        core.debug(`Searching for pull requests associated with commit ${commit.sha}`);
        const pulls = await client.rest.repos.listPullRequestsAssociatedWithCommit({
            owner: owner,
            repo: repo,
            commit_sha: commit.sha,
        });


        if (pulls.data.length) {
            core.info(`Found ${pulls.data.length} pull request(s) associated with commit ${commit.sha}`);
        }

        const clOptions = await getChangelogOptions();
        const parsedCommitMsg: ParsedCommits = commitParser(commit.commit.message, clOptions);

        // istanbul ignore next
        if (parsedCommitMsg.merge) {
            core.debug(`Ignoring merge commit: ${parsedCommitMsg.merge}`);
            continue;
        }

        parsedCommitMsg.extra = {
            commit: commit,
            pullRequests: [],
            issues: [],
            breakingChange: false,
        };

        parsedCommitMsg.extra.pullRequests = pulls.data.map((pr) => {
            return {
                number: pr.number,
                url: pr.html_url,
            };
        });

        parsedCommitMsg.extra.issues = issues.filter(issue => issue.commit_id === commit.sha && issue.issue).map(issue => ({ number: issue.issue!.number, url: issue.issue!.html_url}))

        parsedCommitMsg.extra.breakingChange = isBreakingChange({
            body: parsedCommitMsg.body,
            footer: parsedCommitMsg.footer,
        });
        core.debug(`Parsed commit: ${JSON.stringify(parsedCommitMsg)}`);
        parsedCommits.push(parsedCommitMsg);
        core.info(`Adding commit "${parsedCommitMsg.header}" to the changelog`);
    }

    const changelog = generateChangelogFromParsedCommits(parsedCommits);
    core.debug('Changelog:');
    core.debug(changelog);

    core.endGroup();
    return changelog;
};

async function run(): Promise<void> {
    try {

        const context = new Context();
        const args = parseArguments();


        const client = github.getOctokit(args.token, {
            baseUrl: process.env['JEST_MOCK_HTTP_PORT'] ? `http://localhost:${process.env['JEST_MOCK_HTTP_PORT']}` : undefined,
            log: {
                debug: (...args) => core.debug(octokitLogger(...args)),
                info: (...args) => core.debug(octokitLogger(...args)),
                warn: (...args) => core.warning(octokitLogger(...args)),
                error: (...args) => core.error(octokitLogger(...args)),
            }
        })

        core.startGroup("Determining release tags")
        const releaseTag = parseGitTagRef(context.ref);

        const previewReleaseTag = await searchForPreviousReleaseTag(client, releaseTag, {
            owner: context.repo.owner,
            repo: context.repo.repo,
        })
        core.endGroup();

        const commitsSinceRelease = await getCommitsSinceRelease(client, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            ref: `tags/${previewReleaseTag}`,
        }, context.sha);

        const changelog = await getChangelog(client, context.repo.owner, context.repo.repo, commitsSinceRelease);

        core.startGroup(`Generating new GitHub release for the "${releaseTag}" tag`);

        core.info('Creating new release');
        const releaseUploadUrl = await client.rest.repos.createRelease({
            owner: context.repo.owner,
            repo: context.repo.repo,
            tag_name: releaseTag,
            name: args.title ? args.title : releaseTag,
            draft: args.draft,
            prerelease: args.preRelease,
            body: changelog,
        });
        core.endGroup();

        core.setOutput('upload_url', releaseUploadUrl);

    } catch (error) {
        core.setFailed((error as Error).message);
    }
}

run();
