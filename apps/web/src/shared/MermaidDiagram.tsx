import { useEffect, useRef, useState } from "react";
import { useTheme } from "../features/themes/ThemeProvider";

let diagramSequence = 0;
let mermaidPromise: Promise<typeof import("mermaid")["default"]> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => mermaid);
  }
  return mermaidPromise;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function MermaidDiagram({ source }: { source: string }) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    const id = `overseer-mermaid-${++diagramSequence}`;

    setStatus("loading");
    setError("");
    container?.replaceChildren();

    const styles = getComputedStyle(document.documentElement);

    void loadMermaid()
      .then((mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          suppressErrorRendering: true,
          theme: theme.appearance === "dark" ? "dark" : "neutral",
          themeVariables: {
            background: styles.getPropertyValue("--ov-surface").trim(),
            primaryColor: styles.getPropertyValue("--ov-surface-hover").trim(),
            primaryTextColor: styles.getPropertyValue("--ov-ink").trim(),
            primaryBorderColor: styles.getPropertyValue("--ov-edge-emphasis").trim(),
            lineColor: styles.getPropertyValue("--ov-ink-muted").trim(),
            secondaryColor: styles.getPropertyValue("--ov-surface-raised").trim(),
            tertiaryColor: styles.getPropertyValue("--ov-surface-active").trim(),
          },
        });
        return mermaid.render(id, source);
      })
      .then(({ svg, bindFunctions }) => {
        if (cancelled || !container) return;
        container.innerHTML = svg;
        bindFunctions?.(container);
        setStatus("ready");
      })
      .catch((renderError: unknown) => {
        if (cancelled) return;
        container?.replaceChildren();
        setError(errorMessage(renderError));
        setStatus("error");
      });

    return () => {
      cancelled = true;
      container?.replaceChildren();
    };
  }, [source, theme]);

  return (
    <figure className={`mermaid-diagram mermaid-diagram-${status}`}>
      {status === "loading" && <div className="mermaid-diagram-status">Rendering diagram…</div>}
      <div ref={containerRef} className="mermaid-diagram-canvas" aria-label="Mermaid diagram" />
      {status === "error" && (
        <>
          <figcaption>Could not render Mermaid diagram: {error}</figcaption>
          <pre className="mermaid-diagram-source"><code>{source}</code></pre>
        </>
      )}
    </figure>
  );
}
