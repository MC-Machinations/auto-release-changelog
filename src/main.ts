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
import {getClosedIssues} from "./graphql"
import globby from "globby"
import path from "path"
const fs = require("fs")

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

type ExtendedTag = components["schemas"]["tag"] & {
    semverTag: string;
}

const searchForPreviousReleaseTag = async (
    client: InstanceType<typeof GitHub>,
    currentReleaseTag: string,
    tagInfo: { owner: string, repo: string },
): Promise<ExtendedTag | null> => {
    const validSemver = semverValid(currentReleaseTag);
    if (!validSemver) {
        throw new Error(
            `The the current tag "${currentReleaseTag}" does not appear to conform to semantic versioning.`,
        );
    }

    const listTagsOptions = client.rest.repos.listTags.endpoint.merge({
        ...tagInfo,
        per_page: 100
    });
    const tl = await client.paginate<components["schemas"]["tag"]>(listTagsOptions);

    const tagList = tl
        .map((tag) => {
            core.debug(`Currently processing tag ${tag.name}`);
            const t = semverValid(tag.name);
            return {
                ...tag,
                semverTag: t,
            };
        })
        .filter((tag) => tag.semverTag !== null)
        .sort((a, b) => semverRcompare(a.semverTag!, b.semverTag!)) as ExtendedTag[];

    let previousReleaseTag = null;
    for (const tag of tagList) {
        if (semverLt(tag.semverTag, currentReleaseTag)) {
            previousReleaseTag = tag;
            break;
        }
    }

    return previousReleaseTag;
};

const getCommitsSinceRelease = async (
    client: InstanceType<typeof GitHub>,
    tagInfo: { owner: components["parameters"]["owner"], repo: components["parameters"]["repo"], ref: string },
    currentSha: string,
): Promise<components["schemas"]["commit"][]> => {
    core.startGroup('Retrieving commit history');

    core.info('Determining state of the previous release');
    let previousReleaseRef = '';
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
    previousReleaseTag: ExtendedTag | null,
    commits: components["schemas"]["commit"][],
): Promise<string> => {
    const parsedCommits: ParsedCommits[] = [];
    core.startGroup('Generating changelog');

    let since: Date | null = null;
    if (previousReleaseTag !== null) {
        const commit = await client.rest.repos.getCommit({
            owner: owner,
            repo: repo,
            ref: previousReleaseTag.commit.sha,
        })
        if (commit.data.commit.committer?.date) {
            since = new Date(commit.data.commit.committer.date)
        }
    }

    const closedIssues = await getClosedIssues(client, repo, owner, since);

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

        parsedCommitMsg.extra.issues = closedIssues.filter(issue => issue.oid === commit.sha || parsedCommitMsg.extra.pullRequests.findIndex(pr => pr.number === issue.prNumber) > -1).map(issue => issue.issue)

        // parsedCommitMsg.extra.issues = events.filter(event => event.commit_id === commit.sha).map(event => ({ number: event.issue.number, url: event.issue.html_url}))

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

export async function main(): Promise<void> {
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

        const previousReleaseTag = await searchForPreviousReleaseTag(client, releaseTag, {
            owner: context.repo.owner,
            repo: context.repo.repo,
        })
        core.endGroup();

        const commitsSinceRelease = await getCommitsSinceRelease(client, {
            owner: context.repo.owner,
            repo: context.repo.repo,
            ref: `tags/${previousReleaseTag == null ? '' : previousReleaseTag.name}`,
        }, context.sha);

        const changelog = await getChangelog(client, context.repo.owner, context.repo.repo, previousReleaseTag, commitsSinceRelease);

        core.startGroup(`Generating new GitHub release for the "${releaseTag}" tag`);

        core.info('Creating new release');
        const release = await client.rest.repos.createRelease({
            owner: context.repo.owner,
            repo: context.repo.repo,
            tag_name: releaseTag,
            name: args.title ? args.title : releaseTag,
            draft: args.draft,
            prerelease: args.preRelease,
            body: changelog,
        });
        core.endGroup();

        await uploadReleaseArtifacts(client, context.repo.repo, context.repo.owner, release.data.id, args.files);

        core.setOutput('upload_url', release.data.upload_url);
        core.setOutput('release_id', release.data.id);

    } catch (error) {
        core.setFailed((error as Error).message);
    }
}

export async function uploadReleaseArtifacts(client: InstanceType<typeof GitHub>, repo: string, owner: string, releaseId: number, files: string[]): Promise<void> {
    core.startGroup("Uploading release artifacts")
    for (let file of files) {
        const paths = await globby(file);
        if (paths.length === 0) {
            core.warning(`${file} doesn't match any files`)
        }

        for (let filePath of paths) {
            core.info(`Uploading: ${filePath}`)
            const nameWithExt = path.basename(filePath);

            try {
                await client.rest.repos.uploadReleaseAsset({
                    release_id: releaseId,
                    headers: {
                        "content-length": fs.lstatSync(filePath).size,
                        "content-type": "application/octet-stream",
                    },
                    repo: repo,
                    owner: owner,
                    name: nameWithExt,
                    data: fs.readFileSync(filePath) as unknown as string,
                });
            } catch (err) {
                core.error(`Problem uploading ${filePath} as a release asset (${(err as Error).message}).`)
            }
        }
    }
}
