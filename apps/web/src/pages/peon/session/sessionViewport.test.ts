import test from "node:test";
import assert from "node:assert/strict";
import { lockSessionDocument, sessionRouteShellClass } from "./sessionViewport";

test("an active session confines the route shell to one dynamic viewport", () => {
  assert.equal(sessionRouteShellClass(true), "h-[100dvh] overflow-hidden");
});

test("non-session routes retain normal document scrolling", () => {
  assert.equal(sessionRouteShellClass(false), "min-h-screen");
});

test("the transcript locks and restores the iOS document scroller", () => {
  const rootClasses = new Set<string>();
  const bodyClasses = new Set<string>();
  const properties = new Map<string, string>();
  const restored: number[][] = [];
  const classList = (values: Set<string>) => ({
    add: (...tokens: string[]) => tokens.forEach((token) => values.add(token)),
    remove: (...tokens: string[]) => tokens.forEach((token) => values.delete(token)),
  });
  const target = {
    documentElement: { classList: classList(rootClasses) },
    body: {
      classList: classList(bodyClasses),
      style: {
        getPropertyValue: (name: string) => properties.get(name) ?? "",
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    },
    defaultView: {
      scrollX: 7,
      scrollY: 42,
      scrollTo: (x: number, y: number) => restored.push([x, y]),
    },
  } as unknown as Document;

  const unlock = lockSessionDocument(target);
  assert.equal(rootClasses.has("session-transcript-open"), true);
  assert.equal(bodyClasses.has("session-transcript-open"), true);
  // No `top: -scrollY` offset: it would push the mobile header off screen,
  // and the locked body has no scroller left to reach it.
  assert.equal(properties.size, 0);

  unlock();
  assert.equal(rootClasses.has("session-transcript-open"), false);
  assert.equal(bodyClasses.has("session-transcript-open"), false);
  assert.equal(properties.size, 0);
  assert.deepEqual(restored, [[7, 42]]);
});
