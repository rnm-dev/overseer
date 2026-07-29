import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFileView, resolveWithinDir } from "../files/index.js";
export const PROJECT_DOCS_DIR = "docs";
export const PROJECT_DOCS_INDEX = "index.md";
const SUPPORTED_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const MAX_TREE_DEPTH = 20;
const MAX_TREE_ENTRIES = 2_000;
export class ProjectDocsError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
function titleFromContent(fileName, content) {
    const heading = content.match(/^#{1,6}\s+(.+?)\s*$/m)?.[1]?.trim();
    if (heading)
        return heading;
    return path.basename(fileName, path.extname(fileName)).replace(/[-_]+/g, " ");
}
function normalizeDocPath(input) {
    const normalized = input.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("\0")) {
        throw new ProjectDocsError(400, "INVALID_PATH", "document path is required");
    }
    const segments = normalized.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
        throw new ProjectDocsError(400, "INVALID_PATH", "document path contains an invalid segment");
    }
    if (!SUPPORTED_EXTENSIONS.has(path.extname(normalized).toLowerCase())) {
        throw new ProjectDocsError(415, "UNSUPPORTED_MEDIA_TYPE", "only .md, .mdx, and .txt project documents are supported");
    }
    return normalized;
}
function mapReadError(error) {
    const code = error.code;
    if (code === "ENOENT" || code === "ENOTDIR")
        return new ProjectDocsError(404, "NOT_FOUND", "document not found");
    if (code === "EISDIR")
        return new ProjectDocsError(400, "IS_DIRECTORY", "document path is a directory");
    if (code === "EACCES" || code === "EPERM")
        return new ProjectDocsError(403, "FORBIDDEN", "permission denied");
    return new ProjectDocsError(500, "INTERNAL", "failed to read project documentation");
}
export function readProjectDoc(projectDir, requestedPath) {
    const docPath = normalizeDocPath(requestedPath);
    const docsDir = path.join(projectDir, PROJECT_DOCS_DIR);
    let absPath;
    try {
        absPath = resolveWithinDir(docsDir, docPath);
    }
    catch (error) {
        throw mapReadError(error);
    }
    if (!absPath)
        throw new ProjectDocsError(400, "PATH_ESCAPE", "document path escapes the docs directory");
    try {
        const view = readFileView(absPath);
        if (view.binary || view.content === null) {
            throw new ProjectDocsError(415, "UNSUPPORTED_MEDIA_TYPE", "document is not a text file");
        }
        return {
            path: docPath,
            name: path.basename(docPath),
            title: titleFromContent(docPath, view.content),
            content: view.content,
            size: view.size,
            mtimeMs: view.mtimeMs,
            truncated: view.truncated,
        };
    }
    catch (error) {
        if (error instanceof ProjectDocsError)
            throw error;
        throw mapReadError(error);
    }
}
function docsTree(docsDir) {
    let count = 0;
    const realRoot = realpathSync(docsDir);
    const walk = (absDir, relativeDir, depth) => {
        if (depth > MAX_TREE_DEPTH)
            return [];
        const nodes = [];
        for (const entry of readdirSync(absDir, { withFileTypes: true })) {
            if (entry.name.startsWith("."))
                continue;
            if (++count > MAX_TREE_ENTRIES)
                break;
            const candidate = path.join(absDir, entry.name);
            let realTarget;
            try {
                realTarget = realpathSync(candidate);
            }
            catch {
                continue;
            }
            const relToRoot = path.relative(realRoot, realTarget);
            if (relToRoot === ".." || relToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relToRoot))
                continue;
            const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
            const stat = statSync(realTarget);
            if (stat.isDirectory()) {
                nodes.push({ type: "directory", name: entry.name, path: relativePath, children: walk(realTarget, relativePath, depth + 1) });
            }
            else if (stat.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
                nodes.push({ type: "file", name: entry.name, path: relativePath, size: stat.size, mtimeMs: stat.mtimeMs });
            }
        }
        nodes.sort((a, b) => a.type === b.type
            ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
            : a.type === "directory" ? -1 : 1);
        return nodes;
    };
    return walk(realRoot, "", 0);
}
export function projectDocumentation(projectDir) {
    const docsDir = path.join(projectDir, PROJECT_DOCS_DIR);
    try {
        if (!statSync(docsDir).isDirectory())
            return { exists: false, indexPath: PROJECT_DOCS_INDEX, index: null, tree: [] };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { exists: false, indexPath: PROJECT_DOCS_INDEX, index: null, tree: [] };
        }
        throw mapReadError(error);
    }
    let index = null;
    try {
        index = readProjectDoc(projectDir, PROJECT_DOCS_INDEX);
    }
    catch (error) {
        if (!(error instanceof ProjectDocsError) || error.code !== "NOT_FOUND")
            throw error;
    }
    try {
        return { exists: true, indexPath: PROJECT_DOCS_INDEX, index, tree: docsTree(docsDir) };
    }
    catch (error) {
        throw mapReadError(error);
    }
}
export function ensureProjectDocs(projectDir, projectLabel) {
    const docsDir = path.join(projectDir, PROJECT_DOCS_DIR);
    const indexPath = path.join(docsDir, PROJECT_DOCS_INDEX);
    mkdirSync(docsDir, { recursive: true });
    try {
        statSync(indexPath);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        writeFileSync(indexPath, `# ${projectLabel}\n\nProject documentation.\n`);
    }
}
export function migrateProjectMetadata(projectDir, projectLabel, metadata) {
    const docsDir = path.join(projectDir, PROJECT_DOCS_DIR);
    const indexPath = path.join(docsDir, PROJECT_DOCS_INDEX);
    mkdirSync(docsDir, { recursive: true });
    try {
        statSync(indexPath);
        const legacyName = "legacy-project-metadata.md";
        const legacyPath = path.join(docsDir, legacyName);
        try {
            statSync(legacyPath);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
            writeFileSync(legacyPath, `${metadata.trim()}\n`);
        }
        const index = readFileSync(indexPath, "utf8");
        if (!index.includes(`(${legacyName})`)) {
            writeFileSync(indexPath, `${index.trimEnd()}\n\n## Migrated project information\n\n- [Legacy project metadata](${legacyName})\n`);
        }
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
        writeFileSync(indexPath, `${metadata.trim()}\n`);
    }
    ensureProjectDocs(projectDir, projectLabel);
}
