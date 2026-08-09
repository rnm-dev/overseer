import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetNativeCallback,
  loginRouteTarget,
  nativeCallback,
  rememberNativeCallback,
  type CallbackStore,
} from "./nativeLoginMode";

function store(initial: Record<string, string> = {}): CallbackStore {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

test("a webview callback turns on native mode", () => {
  const s = store();
  const remembered = rememberNativeCallback("?callback=overseer%3A%2F%2Foauth%2Fgithub", s);
  assert.equal(remembered, "overseer://oauth/github");
  assert.equal(nativeCallback(s), "overseer://oauth/github");
});

test("the dev app scheme is kept verbatim for the server's exact-match allowlist", () => {
  const s = store();
  assert.equal(rememberNativeCallback("?callback=overseer-dev://oauth/github", s), "overseer-dev://oauth/github");
});

test("a plain browser visit leaves native mode off", () => {
  const s = store();
  assert.equal(rememberNativeCallback("", s), null);
  assert.equal(nativeCallback(s), null);
});

test("native mode survives the GitHub round trip, which returns without the query", () => {
  const s = store();
  rememberNativeCallback("?callback=overseer://oauth/github", s);
  assert.equal(rememberNativeCallback("?code=gh-code&state=state-1", s), "overseer://oauth/github");
});

test("a web callback cannot arm native mode", () => {
  const s = store();
  assert.equal(rememberNativeCallback("?callback=https://evil.example/steal", s), null);
  assert.equal(rememberNativeCallback("?callback=http://evil.example/steal", s), null);
});

test("a malformed callback cannot arm native mode", () => {
  const s = store();
  assert.equal(rememberNativeCallback("?callback=not-a-url", s), null);
});

test("an armed session is not disarmed by a later visit without the query", () => {
  const s = store();
  rememberNativeCallback("?callback=overseer://oauth/github", s);
  rememberNativeCallback("?callback=https://evil.example/steal", s);
  assert.equal(nativeCallback(s), "overseer://oauth/github");
});

test("a finished web sign-in clears native mode", () => {
  const s = store();
  rememberNativeCallback("?callback=overseer://oauth/github", s);
  forgetNativeCallback(s);
  assert.equal(nativeCallback(s), null);
});

test("a signed-in browser is sent from /login to the dashboard", () => {
  assert.equal(loginRouteTarget(true, store()), "dashboard");
});

test("a signed-out visitor stays on /login", () => {
  assert.equal(loginRouteTarget(false, store()), "login");
});

// The bug this guards: the app's sign-in sheet shares the browser session, so
// the webview arrived already signed in and got the whole dashboard instead of
// a deep link back to the app.
test("a signed-in webview stays on /login to finish the native deep link", () => {
  const s = store();
  rememberNativeCallback("?callback=overseer://oauth/github", s);
  assert.equal(loginRouteTarget(true, s), "login");
});

test("native mode survives the GitHub round trip for a signed-in webview", () => {
  const s = store();
  rememberNativeCallback("?callback=overseer-dev://oauth/github", s);
  rememberNativeCallback("?code=gh-code&state=state-1", s);
  assert.equal(loginRouteTarget(true, s), "login");
});
