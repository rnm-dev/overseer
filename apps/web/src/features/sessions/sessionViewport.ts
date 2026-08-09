export function sessionRouteShellClass(sessionActive: boolean): string {
  // Virtuoso owns transcript scrolling. Keep the route shell itself exactly
  // within the dynamic viewport so mobile browsers cannot expose a second,
  // document-level scroll surface behind it.
  return sessionActive ? "h-[100dvh] overflow-hidden" : "min-h-screen";
}

const SESSION_DOCUMENT_LOCK_CLASS = "session-transcript-open";

// The usual scroll-lock trick pins the body at `top: -scrollY` so the page
// keeps its place. Here it hid the mobile header: the session view is fixed
// over the whole viewport, so the only thing left in normal flow is that
// header — and a body offset by the page's old scroll position carries it
// (and the sticky desktop sidebar) straight off the top of the screen, with
// no scroller left to bring it back. Nothing behind the transcript needs its
// former offset, and unlocking restores the scroll position anyway.
export function lockSessionDocument(target: Document): () => void {
  const root = target.documentElement;
  const body = target.body;
  const view = target.defaultView;
  const scrollX = view?.scrollX ?? 0;
  const scrollY = view?.scrollY ?? 0;

  root.classList.add(SESSION_DOCUMENT_LOCK_CLASS);
  body.classList.add(SESSION_DOCUMENT_LOCK_CLASS);

  return () => {
    root.classList.remove(SESSION_DOCUMENT_LOCK_CLASS);
    body.classList.remove(SESSION_DOCUMENT_LOCK_CLASS);
    view?.scrollTo(scrollX, scrollY);
  };
}
