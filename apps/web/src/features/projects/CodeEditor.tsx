import { useEffect, useRef } from "react";
import { gutterWidthCh, lineNumberText } from "../../shared/lineNumbers";

// The editor mirrors the read-only view: the same gutter, the same font, the
// same refusal to wrap — a wrapped line would make the numbers beside it lie.
// The textarea grows to its whole content and the box around it scrolls, so
// the gutter needs no scroll listener to stay in step.
export function CodeEditor({ value, onChange, label, className = "" }: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  className?: string;
}) {
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const node = area.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
  }, [value]);

  return (
    <div className={`code-view code-view--flush code-view--numbered min-h-full ${className}`}>
      <span aria-hidden className="code-gutter" style={{ width: `${gutterWidthCh(value)}ch` }}>{lineNumberText(value)}</span>
      <textarea
        ref={area}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Tab belongs to the file being edited, not to the focus ring.
          if (event.key !== "Tab" || event.shiftKey) return;
          event.preventDefault();
          const node = event.currentTarget;
          const { selectionStart, selectionEnd } = node;
          onChange(`${value.slice(0, selectionStart)}\t${value.slice(selectionEnd)}`);
          requestAnimationFrame(() => node.setSelectionRange(selectionStart + 1, selectionStart + 1));
        }}
        spellCheck={false}
        wrap="off"
        aria-label={label}
        className="min-w-0 flex-1 resize-none overflow-hidden border-0 bg-transparent p-0 font-[inherit] leading-[inherit] text-ink outline-none"
      />
    </div>
  );
}
