export function sessionRouteShellClass(sessionActive: boolean): string {
  // Virtuoso owns transcript scrolling. Keep the route shell itself exactly
  // within the dynamic viewport so mobile browsers cannot expose a second,
  // document-level scroll surface behind it.
  return sessionActive ? "h-[100dvh] overflow-hidden" : "min-h-screen";
}

const SESSION_DOCUMENT_LOCK_CLASS = "session-transcript-open";
const SESSION_DOCUMENT_LOCK_TOP = "--session-document-lock-top";

export function lockSessionDocument(target: Document): () => void {
  const root = target.documentElement;
  const body = target.body;
  const view = target.defaultView;
  const scrollX = view?.scrollX ?? 0;
  const scrollY = view?.scrollY ?? 0;
  const previousTop = body.style.getPropertyValue(SESSION_DOCUMENT_LOCK_TOP);

  body.style.setProperty(SESSION_DOCUMENT_LOCK_TOP, `${-scrollY}px`);
  root.classList.add(SESSION_DOCUMENT_LOCK_CLASS);
  body.classList.add(SESSION_DOCUMENT_LOCK_CLASS);

  return () => {
    root.classList.remove(SESSION_DOCUMENT_LOCK_CLASS);
    body.classList.remove(SESSION_DOCUMENT_LOCK_CLASS);
    if (previousTop) body.style.setProperty(SESSION_DOCUMENT_LOCK_TOP, previousTop);
    else body.style.removeProperty(SESSION_DOCUMENT_LOCK_TOP);
    view?.scrollTo(scrollX, scrollY);
  };
}
