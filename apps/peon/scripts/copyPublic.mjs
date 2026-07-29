#!/usr/bin/env node
// The dashboard's browser assets (src/dashboard/public — plain HTML/JS/JSX transformed
// client-side by @babel/standalone) aren't TypeScript, so tsc never touches them. The
// compiled server (dist/dashboard/server.js) serves them from `${__dirname}/public`, so
// they have to sit next to it under dist/. Copy them there as the last build step.
import { cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src", "dashboard", "public");
const dest = path.join(root, "dist", "dashboard", "public");

if (!existsSync(src)) {
  console.error(`copyPublic: ${src} does not exist`);
  process.exit(1);
}

cpSync(src, dest, { recursive: true });
console.log(`copyPublic: ${src} -> ${dest}`);
