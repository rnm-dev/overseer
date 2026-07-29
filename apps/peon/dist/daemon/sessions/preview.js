import path from "node:path";
import { tmpdir } from "node:os";
const PREVIEW_DIRECTIVE_RE = /\[\[peon-preview:\s*([^]\r\n]+?)\s*\]\]/gi;
const EXPLICIT_PREVIEW_LINK_RE = /\[\s*Open preview\s*\]\((\/[^)\r\n]+)\)/gi;
const AGENT_PREVIEW_EXTENSIONS = new Set([
    ".html", ".htm", ".md", ".markdown", ".pdf",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
]);
export function sessionPreviewDir(id) {
    return path.join(tmpdir(), "peon-previews", id);
}
export function previewPathsFromAgentEvent(event) {
    const paths = [];
    if (event.type === "assistant") {
        const parts = event.message?.content;
        if (Array.isArray(parts)) {
            for (const part of parts) {
                const text = part?.type === "text"
                    ? part.text
                    : null;
                if (typeof text !== "string")
                    continue;
                for (const match of text.matchAll(PREVIEW_DIRECTIVE_RE)) {
                    if (match[1]?.trim())
                        paths.push(match[1].trim());
                }
                for (const match of text.matchAll(EXPLICIT_PREVIEW_LINK_RE)) {
                    if (match[1]?.trim())
                        paths.push(decodePreviewPath(match[1].trim()));
                }
            }
        }
    }
    if (event.type === "result") {
        const structured = event.structured_output;
        if (typeof structured?.previewPath === "string" && structured.previewPath.trim()) {
            paths.push(structured.previewPath.trim());
        }
    }
    return [...new Set(paths)];
}
function decodePreviewPath(value) {
    try {
        return decodeURIComponent(value);
    }
    catch {
        return value;
    }
}
export function isAgentPreviewArtifact(filePath) {
    return AGENT_PREVIEW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
