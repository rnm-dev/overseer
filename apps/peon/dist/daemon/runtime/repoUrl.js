// Project metadata is admin-authored free text ("repo, servers,
// deploy, env, conventions" per its API description) — there's no
// structured repoUrl field anywhere in the API. This heuristically pulls a
// git URL out of it. SSH auth is configured only for github.com (see
// ~/.ssh/config), so any matched GitHub URL — SSH or HTTPS or bare — gets
// normalized to SSH form; other hosts are returned as-is (HTTPS, since we
// have no credential set up for them yet).
const PATTERNS = [
    {
        // git@host:org/repo(.git)
        re: /git@([\w.-]+):([\w./-]+?)(?:\.git)?(?=[\s)\]"'>]|$)/,
        toUrl: (m) => `git@${m[1]}:${m[2]}.git`,
    },
    {
        // https://github.com/org/repo(.git)
        re: /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s)\]"'>]|$)/,
        toUrl: (m) => `git@github.com:${m[1]}/${m[2]}.git`,
    },
    {
        // bare github.com/org/repo — not preceded by @, :, or / (would mean it's
        // part of one of the two patterns above, already tried first)
        re: /(?<![\w@:/])github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\s)\]"'>]|$)/,
        toUrl: (m) => `git@github.com:${m[1]}/${m[2]}.git`,
    },
    {
        // any other host's https .git URL — left as HTTPS, no credential configured
        re: /https?:\/\/[\w.-]+\/[\w./-]+?\.git(?=[\s)\]"'>]|$)/,
        toUrl: (m) => m[0],
    },
];
export function extractRepoUrl(info) {
    if (!info)
        return null;
    for (const { re, toUrl } of PATTERNS) {
        const match = info.match(re);
        if (match)
            return toUrl(match);
    }
    return null;
}
