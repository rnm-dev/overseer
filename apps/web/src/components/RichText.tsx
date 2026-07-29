import { isValidElement, useMemo, type ComponentPropsWithoutRef, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cmake from "highlight.js/lib/languages/cmake";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import dart from "highlight.js/lib/languages/dart";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import graphql from "highlight.js/lib/languages/graphql";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import less from "highlight.js/lib/languages/less";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import scss from "highlight.js/lib/languages/scss";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const languages = {
  bash, c, cmake, cpp, csharp, css, dart, dockerfile, go, graphql, ini, java,
  javascript, json, kotlin, less, lua, makefile, markdown, php, powershell,
  python, r, ruby, rust, scala, scss, sql, swift, typescript, xml, yaml,
};
for (const [name, grammar] of Object.entries(languages)) hljs.registerLanguage(name, grammar);

function highlightedMarkup(source: string, language: string | null): string | null {
  if (!language || language === "plaintext" || !hljs.getLanguage(language)) return null;
  // highlight.js escapes source text before producing these markup-only spans.
  return hljs.highlight(source, { language, ignoreIllegals: true }).value;
}

function MarkdownCode({ className, children, node: _node, ...props }: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  const source = String(children).replace(/\n$/, "");
  const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1] ?? null;
  const highlighted = highlightedMarkup(source, language);
  if (highlighted !== null) {
    return <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />;
  }
  return <code className={className || "markdown-inline-code"} {...props}>{children}</code>;
}

function MarkdownPre({ children, node: _node, ...props }: ComponentPropsWithoutRef<"pre"> & { node?: unknown }) {
  const code = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const language = /(?:^|\s)language-([^\s]+)/.exec(code?.props.className ?? "")?.[1]?.toLowerCase();
  if (language === "mermaid") {
    return <MermaidDiagram source={String(code?.props.children ?? "").replace(/\n$/, "")} />;
  }
  return <pre {...props}>{children}</pre>;
}

const baseMarkdownComponents: Components = {
  table: ({ children }) => <div className="markdown-table-wrap"><table>{children}</table></div>,
  code: MarkdownCode,
  pre: MarkdownPre,
};

function localFilePath(href: string | undefined): string | null {
  if (!href) return null;
  let path = href;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the original path when it contains a malformed escape sequence.
  }
  if (path.startsWith("file://")) {
    try {
      path = new URL(path).pathname;
    } catch {
      return null;
    }
  }
  if (!(path.startsWith("/") && !path.startsWith("//")) && !/^[a-zA-Z]:[\\/]/.test(path)) return null;
  // Codex file links can carry a source position as /path/file.ts:12:4 or #L12.
  return path.replace(/#L\d+(?:-L?\d+)?$/, "").replace(/:\d+(?::\d+)?$/, "");
}

export function Markdown({ source, className = "", onOpenFile, onOpenLink, transformLink }: {
  source: string;
  className?: string;
  onOpenFile?: (path: string) => void;
  onOpenLink?: (href: string) => boolean;
  transformLink?: (href: string) => string | null;
}) {
  const components = useMemo<Components>(() => ({
    ...baseMarkdownComponents,
    a: ({ children, href }) => {
      const transformed = href ? transformLink?.(href) : null;
      if (transformed && transformed !== href) {
        return <a href={transformed} target="_blank" rel="noopener noreferrer" onClick={(event) => {
          if (onOpenLink?.(transformed)) event.preventDefault();
        }}>{children}</a>;
      }
      const path = localFilePath(href);
      if (path && onOpenFile) {
        return <a href={href} onClick={(event) => { event.preventDefault(); onOpenFile(path); }}>{children}</a>;
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
        if (href && onOpenLink?.(href)) event.preventDefault();
      }}>{children}</a>;
    },
  }), [onOpenFile, onOpenLink, transformLink]);

  return (
    <div className={`markdown-body ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        skipHtml
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", php: "php", java: "java", kt: "kotlin", kts: "kotlin",
  go: "go", rs: "rust", c: "c", h: "c", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  cs: "csharp", swift: "swift", scala: "scala", dart: "dart", lua: "lua", r: "r",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash", ps1: "powershell",
  html: "xml", htm: "xml", xml: "xml", svg: "xml", vue: "xml", svelte: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  json: "json", jsonc: "json", json5: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
  sql: "sql", graphql: "graphql", gql: "graphql", md: "markdown", markdown: "markdown", mdx: "markdown",
  dockerfile: "dockerfile", makefile: "makefile", cmake: "cmake",
};

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  "cmakelists.txt": "cmake",
  "package.json": "json",
  "tsconfig.json": "json",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".prettierrc": "json",
  ".env": "bash",
  ".gitignore": "plaintext",
};

export function languageForPath(filePath: string): string | null {
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (LANGUAGE_BY_FILENAME[name]) return LANGUAGE_BY_FILENAME[name];
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

export function HighlightedCode({ source, language, className = "" }: {
  source: string;
  language?: string | null;
  className?: string;
}) {
  const highlighted = useMemo(() => {
    return highlightedMarkup(source, language ?? null);
  }, [source, language]);

  return (
    <pre className={`code-view ${className}`}>
      {highlighted === null
        ? <code>{source}</code>
        : <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />}
    </pre>
  );
}
