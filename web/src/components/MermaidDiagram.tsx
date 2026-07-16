import { useEffect, useRef, useState } from "react";

let diagramSequence = 0;
let mermaidPromise: Promise<typeof import("mermaid")["default"]> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "dark",
        themeVariables: {
          background: "#111411",
          primaryColor: "#262a23",
          primaryTextColor: "#e8e2d3",
          primaryBorderColor: "#596052",
          lineColor: "#a8b19d",
          secondaryColor: "#1b211b",
          tertiaryColor: "#30362d",
        },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function MermaidDiagram({ source }: { source: string }) {
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

    void loadMermaid()
      .then((mermaid) => mermaid.render(id, source))
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
  }, [source]);

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
