import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const peonRoot = path.join(repositoryRoot, "apps", "peon");

const stableServerTests = [
  "apps/server/src/reverseFleetSecurity.test.ts",
  "apps/server/src/peonClaimProtocolContract.test.ts",
  "apps/server/src/proxyTrust.test.ts",
  "apps/server/src/reverseCommandProtocolContract.test.ts",
  "apps/server/src/reverseCommandGateway.test.ts",
  "apps/server/src/peonSocket.test.ts",
  "apps/server/src/peonTransferSocket.test.ts",
  "apps/server/src/peonFileSandbox.test.ts",
  "apps/server/src/folderBrowse.test.ts",
  "apps/server/src/projectViewer.test.ts",
  "apps/server/src/webPreview.test.ts",
  "apps/server/src/access.test.ts",
].map((file) => path.join(repositoryRoot, file));

const stablePeonTests = [
  "reverseCommandChannel.test.ts",
  "reverseCommandLedger.test.ts",
  "peonSocket.test.ts",
  "peonCredentialSocketGeneration.test.ts",
  "peonClaimProtocolContract.test.ts",
  "peonClaimClient.test.ts",
  "projectFileReadChannel.test.ts",
  "sandboxFileReadChannel.test.ts",
  "folderListingChannel.test.ts",
  "settingsCredentials.test.ts",
].map((file) => path.join(peonRoot, "src", "daemon", "__tests__", file));

const groups = [
  {
    label: "Overseer stable reverse-fleet security boundary",
    cwd: repositoryRoot,
    args: [
      "--import",
      "tsx",
      "--test",
      "--test-concurrency=1",
      ...stableServerTests,
    ],
    env: { NODE_ENV: "test" },
  },
  {
    label: "Peon stable reverse-fleet security boundary",
    cwd: peonRoot,
    args: [
      "--import",
      "tsx",
      "--import",
      path.join(peonRoot, "scripts", "test-isolation.mjs"),
      "--test",
      "--test-concurrency=1",
      ...stablePeonTests,
    ],
    env: { NODE_ENV: "test", PEON_TEST_RUN: "1" },
  },
];

for (const group of groups) {
  process.stdout.write(`\n${group.label}\n`);
  const result = spawnSync(process.execPath, group.args, {
    cwd: group.cwd,
    env: { ...process.env, ...group.env },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
