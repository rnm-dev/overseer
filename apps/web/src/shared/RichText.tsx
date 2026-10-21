import { isValidElement, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { gutterWidthCh, lineNumberText } from "./lineNumbers";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "./MermaidDiagram";
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
// Grammars load on first use, so the core bundle carries none of them.
const grammars: Record<string, () => Promise<{ default: LanguageFn }>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cmake: () => import("highlight.js/lib/languages/cmake"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  dart: () => import("highlight.js/lib/languages/dart"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scala: () => import("highlight.js/lib/languages/scala"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};
const aliases: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", h: "c", "c++": "cpp", cs: "csharp", docker: "dockerfile",
  golang: "go", toml: "ini", js: "javascript", jsx: "javascript", kt: "kotlin", md: "markdown",
  py: "python", rb: "ruby", rs: "rust", ts: "typescript", tsx: "typescript", html: "xml", yml: "yaml",
};

// Returns a counter that bumps once the grammar for `language` is registered.
function useGrammar(language: string | null): number {
  const [loaded, setLoaded] = useState(0);
  useEffect(() => {
    const name = language && (aliases[language] ?? language);
    const load = name ? grammars[name] : undefined;
    if (!name || !load || hljs.getLanguage(name)) return;
    let live = true;
    void load().then((m) => {
      if (!hljs.getLanguage(name)) hljs.registerLanguage(name, m.default);
      if (!hljs.getLanguage(language!)) hljs.registerAliases(language!, { languageName: name });
      if (live) setLoaded((n) => n + 1);
    });
    return () => { live = false; };
  }, [language]);
  return loaded;
}

function highlightedMarkup(source: string, language: string | null): string | null {
  if (!language || language === "plaintext" || !hljs.getLanguage(language)) return null;
  // highlight.js escapes source text before producing these markup-only spans.
  return hljs.highlight(source, { language, ignoreIllegals: true }).value;
}

function MarkdownCode({ className, children, node: _node, ...props }: ComponentPropsWithoutRef<"code"> & { node?: unknown }) {
  const source = String(children).replace(/\n$/, "");
  const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? "")?.[1] ?? null;
  useGrammar(language);
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

export function localFilePath(href: string | undefined): string | null {
  if (!href) return null;
  let path = href;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the original path when it contains a malformed escape sequence.
  }
  if (path.startsWith("file://")) {
    try {
      // A URL pathname always opens with a slash, which is part of a POSIX
      // path and never part of a Windows one: file:///C:/work/a.html reads
      // back as /C:/work/a.html, and a Peon asked for that answers NOT_FOUND.
      // Decoded after parsing, not before: `new URL` re-encodes the space in
      // a name the first decode had already opened up, and the Peon is then
      // asked for a file called `a%20file.html`.
      path = decodeURIComponent(new URL(path).pathname).replace(/^\/(?=[a-zA-Z]:[\\/])/, "");
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

export function HighlightedCode({ source, language, className = "", lineNumbers = false }: {
  source: string;
  language?: string | null;
  className?: string;
  // Off by default: a snippet inside a transcript is quoted prose, while a
  // whole file shown as a pane's content is something people cite by line.
  lineNumbers?: boolean;
}) {
  const loaded = useGrammar(language ?? null);
  const highlighted = useMemo(() => {
    return highlightedMarkup(source, language ?? null);
    // `loaded` is read only as a trigger: the grammar registers globally, so
    // the markup must be recomputed once it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, language, loaded]);
  const code = highlighted === null
    ? <code>{source}</code>
    : <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />;

  if (!lineNumbers) return <pre className={`code-view ${className}`}>{code}</pre>;
  return (
    <pre className={`code-view code-view--numbered ${className}`}>
      {/* Inside the scrolling box, so vertical scroll carries it; stuck to the
          left, so horizontal scroll does not take it away. */}
      <span aria-hidden className="code-gutter" style={{ width: `${gutterWidthCh(source)}ch` }}>{lineNumberText(source)}</span>
      {code}
    </pre>
  );
}
