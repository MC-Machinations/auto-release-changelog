import * as core from "@actions/core";

const TAG_REGEX = new RegExp("^(refs\/)?tags\/(.*)$")

export function parseGitTagRef(ref: string): string {
    const match = ref.match(TAG_REGEX);
    if (!match || !match[2]) {
        core.debug(`${ref} does not appear to be a tag ref`)
        throw new TypeError(`${ref} does not appear to be a tag ref. Perhaps this isn't a GitHub tag event?`)
    }
    return match[2];
}

export const octokitLogger = (...args: any[]): string => {
    return args
        .map((arg) => {
            if (typeof arg === 'string') {
                return arg;
            }

            const argCopy = {...arg};

            // Do not log file buffers
            if (argCopy.file) {
                argCopy.file = '== raw file buffer info removed ==';
            }
            if (argCopy.data) {
                argCopy.data = '== raw file buffer info removed ==';
            }

            return JSON.stringify(argCopy);
        })
        .reduce((acc, val) => `${acc} ${val}`, '');
};