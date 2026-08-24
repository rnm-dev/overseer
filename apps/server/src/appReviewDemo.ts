const APPROVED_PRODUCTION_ORIGINS = new Set([
  "https://overseer.rnm.dev",
  "https://demo.ovrseer.org",
]);

export function appReviewDemoEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    env.NODE_ENV === "production" &&
    env.OVERSEER_APP_REVIEW_DEMO === "1" &&
    APPROVED_PRODUCTION_ORIGINS.has(env.OVERSEER_PUBLIC_URL ?? "")
  );
}

export function screenshotDemoEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    (env.NODE_ENV === "development" &&
      env.OVERSEER_PUBLIC_URL === "https://overseer-dev.rnm.dev") ||
    appReviewDemoEnabled(env)
  );
}
