import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
const MAX_SKILL_FILE_BYTES = 64 * 1024;
const MAX_PROJECT_SKILL_ENTRIES = 512;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
function compareText(a, b) {
    return a === b ? 0 : a < b ? -1 : 1;
}
function isWithin(root, candidate) {
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
function scalar(lines, key) {
    const prefix = new RegExp(`^${key}:\\s*(.*)$`);
    const index = lines.findIndex((line) => prefix.test(line));
    if (index < 0)
        return null;
    const raw = lines[index].match(prefix)?.[1]?.trim() ?? "";
    if (raw.startsWith("|") || raw.startsWith(">")) {
        const block = [];
        for (const line of lines.slice(index + 1)) {
            if (line && !/^\s/.test(line))
                break;
            block.push(line);
        }
        const indents = block.filter(Boolean).map((line) => line.match(/^\s*/)?.[0].length ?? 0);
        const indent = indents.length ? Math.min(...indents) : 0;
        const values = block.map((line) => line.slice(indent));
        return (raw.startsWith(">") ? values.join(" ") : values.join("\n")).trim();
    }
    if (raw.startsWith('"') && raw.endsWith('"')) {
        try {
            const value = JSON.parse(raw);
            return typeof value === "string" ? value.trim() : null;
        }
        catch {
            return null;
        }
    }
    if (raw.startsWith("'") && raw.endsWith("'"))
        return raw.slice(1, -1).replace(/''/g, "'").trim();
    return raw.trim();
}
function parseSkill(file, displayPath) {
    let descriptor = null;
    try {
        descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        const details = fstatSync(descriptor);
        if (!details.isFile() || details.size > MAX_SKILL_FILE_BYTES)
            return null;
        const lines = readFileSync(descriptor, "utf8").replace(/\r\n?/g, "\n").split("\n");
        if (lines[0]?.trim() !== "---")
            return null;
        const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
        if (end < 0)
            return null;
        const frontmatter = lines.slice(1, end);
        const name = scalar(frontmatter, "name");
        const description = scalar(frontmatter, "description");
        if (!name || !SKILL_NAME.test(name) || !description || description.length > 4096)
            return null;
        return { name, description, path: displayPath, scope: "project" };
    }
    catch {
        return null;
    }
    finally {
        if (descriptor !== null)
            closeSync(descriptor);
    }
}
export function listProjectSkills(projectDir) {
    try {
        const projectRoot = realpathSync(projectDir);
        const skillRoot = realpathSync(path.join(projectRoot, ".agents", "skills"));
        if (!isWithin(projectRoot, skillRoot))
            return [];
        const entries = readdirSync(skillRoot, { withFileTypes: true })
            .sort((a, b) => compareText(a.name, b.name))
            .slice(0, MAX_PROJECT_SKILL_ENTRIES);
        const skills = entries.flatMap((entry) => {
            try {
                if (!entry.isDirectory() && !entry.isSymbolicLink())
                    return [];
                const directory = realpathSync(path.join(skillRoot, entry.name));
                if (!isWithin(projectRoot, directory) || !statSync(directory).isDirectory())
                    return [];
                const skillFile = realpathSync(path.join(directory, "SKILL.md"));
                if (!isWithin(projectRoot, skillFile))
                    return [];
                const displayPath = path.posix.join(".agents", "skills", entry.name, "SKILL.md");
                const skill = parseSkill(skillFile, displayPath);
                return skill ? [skill] : [];
            }
            catch {
                return [];
            }
        });
        return skills.sort((a, b) => compareText(a.name, b.name) || compareText(a.path, b.path));
    }
    catch {
        return [];
    }
}
