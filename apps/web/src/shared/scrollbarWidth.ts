// Fixed overlays that sit on top of a scrolling pane — the session composer's
// fade is the visible one — must stop before the pane's scrollbar instead of
// painting over it. Only the browser knows how wide that scrollbar is, so
// measure it once and publish it as a custom property.
export const SCROLLBAR_WIDTH_PROPERTY = "--ov-scrollbar-width";

export function measureScrollbarWidth(doc: Document): number {
  const probe = doc.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden";
  doc.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

// Overlay scrollbars measure 0 and need no room; page zoom changes the value,
// so re-measure when the viewport does.
export function trackScrollbarWidth(view: Window): () => void {
  const apply = () => {
    const width = measureScrollbarWidth(view.document);
    view.document.documentElement.style.setProperty(SCROLLBAR_WIDTH_PROPERTY, `${width}px`);
  };
  apply();
  view.addEventListener("resize", apply);
  return () => view.removeEventListener("resize", apply);
}
