import * as core from '@actions/core';
import {components} from "@octokit/openapi-types"
// @ts-ignore
import defaultChangelogOpts from "conventional-changelog-angular/conventional-recommended-bump";

export const getShortSHA = (sha: string): string => {
    const coreAbbrev = 7;
    return sha.substring(0, coreAbbrev);
};

export type ParsedCommitsExtraCommit = components["schemas"]["commit"] & {
    distinct: boolean;
    id: string;
    message: string;
    timestamp: string;
    tree_id: string;
    url: string;
};

type ParsedCommitsExtra = {
    commit: ParsedCommitsExtraCommit;
    pullRequests: {
        number: number;
        url: string;
    }[];
    breakingChange: boolean;
};

enum ConventionalCommitTypes {
    feat = 'Features',
    fix = 'Bug Fixes',
    docs = 'Documentation',
    style = 'Styles',
    refactor = 'Code Refactoring',
    perf = 'Performance Improvements',
    test = 'Tests',
    build = 'Builds',
    ci = 'Continuous Integration',
    chore = 'Chores',
    revert = 'Reverts',
}

export type ParsedCommits = {
    type: ConventionalCommitTypes;
    scope: string;
    subject: string;
    merge: string;
    header: string;
    body: string;
    footer: string;
    notes: {
        title: string;
        text: string;
    }[];
    extra: ParsedCommitsExtra;
    references: {
        action: string;
        owner: string;
        repository: string;
        issue: string;
        raw: string;
        prefix: string;
    }[];
    mentions: string[];
    revert: boolean;
};

const getFormattedChangelogEntry = (parsedCommit: ParsedCommits): string => {
    let entry = '';

    const url = parsedCommit.extra.commit.html_url;
    const sha = getShortSHA(parsedCommit.extra.commit.sha);
    const author = parsedCommit.extra.commit.author?.name;

    let prString = '';
    prString = parsedCommit.extra.pullRequests.reduce((acc, pr) => {
        // e.g. #1
        // e.g. #1,#2
        // e.g. ''
        if (acc) {
            acc += ',';
        }
        return `${acc}[#${pr.number}](${pr.url})`;
    }, '');
    if (prString) {
        prString = ' ' + prString;
    }

    entry = `- ${sha}: ${parsedCommit.header} (${author})${prString}`;
    if (parsedCommit.type) {
        const scopeStr = parsedCommit.scope ? `**${parsedCommit.scope}**: ` : '';
        entry = `- ${scopeStr}${parsedCommit.subject}${prString} ([${author}](${url}))`;
    }

    return entry;
};

export const generateChangelogFromParsedCommits = (parsedCommits: ParsedCommits[]): string => {
    let changelog = '';

    // Breaking Changes
    const breaking = parsedCommits
        .filter((val) => val.extra.breakingChange === true)
        .map((val) => getFormattedChangelogEntry(val))
        .reduce((acc, line) => `${acc}\n${line}`, '');
    if (breaking) {
        changelog += '## Breaking Changes\n';
        changelog += breaking.trim();
    }

    for (const key of Object.keys(ConventionalCommitTypes)) {
        const clBlock = parsedCommits
            .filter((val) => val.type === key)
            .map((val) => getFormattedChangelogEntry(val))
            .reduce((acc, line) => `${acc}\n${line}`, '');
        if (clBlock) {
            changelog += `\n\n## ${ConventionalCommitTypes[key as keyof typeof ConventionalCommitTypes]}\n`;
            changelog += clBlock.trim();
        }
    }

    // Commits
    const commits = parsedCommits
        .filter((val) => val.type === null || Object.keys(ConventionalCommitTypes).indexOf(val.type) === -1)
        .map((val) => getFormattedChangelogEntry(val))
        .reduce((acc, line) => `${acc}\n${line}`, '');
    if (commits) {
        changelog += '\n\n## Commits\n';
        changelog += commits.trim();
    }

    return changelog.trim();
};

export const isBreakingChange = ({body, footer}: {body: string; footer: string}): boolean => {
    const re = /^BREAKING\s+CHANGES?:\s+/;
    return re.test(body || '') || re.test(footer || '');
};

export const getChangelogOptions = async () => {
    const defaultOpts = defaultChangelogOpts;
    defaultOpts['mergePattern'] = '^Merge pull request #(.*) from (.*)$';
    defaultOpts['mergeCorrespondence'] = ['issueId', 'source'];
    core.debug(`Changelog options: ${JSON.stringify(defaultOpts)}`);
    return defaultOpts;
};
