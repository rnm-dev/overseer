import assert from "node:assert/strict";
import test from "node:test";
import {
  appReviewDemoEnabled,
  screenshotDemoEnabled,
} from "./appReviewDemo.js";

test("App Review demo is limited to explicit production origins", () => {
  for (const origin of [
    "https://overseer.rnm.dev",
    "https://demo.ovrseer.org",
  ]) {
    assert.equal(
      appReviewDemoEnabled({
        NODE_ENV: "production",
        OVERSEER_APP_REVIEW_DEMO: "1",
        OVERSEER_PUBLIC_URL: origin,
      }),
      true,
    );
  }
  assert.equal(
    appReviewDemoEnabled({
      NODE_ENV: "production",
      OVERSEER_APP_REVIEW_DEMO: "1",
      OVERSEER_PUBLIC_URL: "https://attacker.example",
    }),
    false,
  );
  assert.equal(
    appReviewDemoEnabled({
      NODE_ENV: "production",
      OVERSEER_PUBLIC_URL: "https://demo.ovrseer.org",
    }),
    false,
  );
});

test("development demo remains limited to the development origin", () => {
  assert.equal(
    screenshotDemoEnabled({
      NODE_ENV: "development",
      OVERSEER_PUBLIC_URL: "https://overseer-dev.rnm.dev",
    }),
    true,
  );
  assert.equal(
    screenshotDemoEnabled({
      NODE_ENV: "development",
      OVERSEER_PUBLIC_URL: "https://demo.ovrseer.org",
    }),
    false,
  );
});
