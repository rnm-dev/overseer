import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { config } from "./config.js";
import { initDb } from "./infrastructure/db/index.js";
import { clientInfo } from "./routes/helpers.js";
import { createServer } from "./server.js";

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const cloudflareCidrs = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

async function listen(): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(createServer());
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  return { port, server };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function post(
  port: number,
  route: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<JsonResponse> {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

function spoofedHeaders(index: number, token?: string): Record<string, string> {
  return {
    "x-forwarded-for": `198.51.100.${index + 1}`,
    "cf-connecting-ip": `203.0.113.${index + 1}`,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function directKamalHeaders(index: number, token?: string): Record<string, string> {
  const attackerPrefix = index % 3 === 0
    ? `not-an-ip-${index}`
    : index % 3 === 1
      ? `198.51.100.${index + 1}, malformed-intermediate-${index}`
      : `198.51.100.${index + 1}`;
  return {
    // kamal-proxy v0.9.2 preserves the inbound values to the left, then
    // appends the direct TCP peer at the right. Express must stop at that
    // first untrusted address and never consume the attacker prefix.
    "x-forwarded-for": `${attackerPrefix}, 203.0.113.240`,
    "cf-connecting-ip": `192.0.2.${index + 1}`,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

function malformedRightmostHeaders(index: number, token?: string): Record<string, string> {
  return {
    // This cannot be emitted by a conforming proxy (the appended socket peer is
    // an IP), but it proves malformed rightmost tokens collapse to the trusted
    // socket peer rather than becoming attacker-selected rate-limit identities.
    "x-forwarded-for": `198.51.100.${index + 1}, malformed-rightmost-${index}`,
    "cf-connecting-ip": `192.0.2.${index + 1}`,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

test("client attribution normalizes IP literals and rejects forwarded addresses carrying ports", () => {
  const request = (
    forwarded: string | undefined,
    peer: string | undefined,
  ): Parameters<typeof clientInfo>[0] => ({
    ip: forwarded,
    socket: { remoteAddress: peer },
    headers: {},
  }) as unknown as Parameters<typeof clientInfo>[0];

  assert.equal(clientInfo(request("::ffff:203.0.113.7", "::ffff:127.0.0.1")).ip, "203.0.113.7");
  assert.equal(clientInfo(request("2001:db8::7", "::ffff:127.0.0.1")).ip, "2001:db8::7");
  assert.equal(clientInfo(request("203.0.113.7:8443", "::ffff:127.0.0.1")).ip, "127.0.0.1");
  assert.equal(clientInfo(request("[2001:db8::7]:8443", "2001:db8::1")).ip, "2001:db8::1");
  assert.equal(clientInfo(request(undefined, "::ffff:192.0.2.9")).ip, "192.0.2.9");
});

test("direct-origin forwarding headers cannot rotate auth rate keys", async () => {
  const original = {
    publicUrl: config.publicUrl,
    githubClientId: config.githubClientId,
    githubClientSecret: config.githubClientSecret,
    trustedProxies: config.trustedProxies,
  };
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.githubClientId = "proxy-trust-client";
  config.githubClientSecret = "proxy-trust-secret";
  config.trustedProxies = [];

  const { port, server } = await listen();
  try {
    for (let index = 0; index < 11; index += 1) {
      const response = await post(port, "/api/auth/github/start", {}, spoofedHeaders(index));
      assert.equal(response.status, index < 10 ? 200 : 429);
      if (index === 10) assert.equal(response.body.code, "RATE_LIMITED");
    }

  } finally {
    await close(server);
    Object.assign(config, original);
  }
});

test("trusted Kamal keeps its appended direct peer authoritative across spoofed and malformed XFF", async () => {
  const original = {
    publicUrl: config.publicUrl,
    githubClientId: config.githubClientId,
    githubClientSecret: config.githubClientSecret,
    githubNativeCallbacks: config.githubNativeCallbacks,
    trustedProxies: config.trustedProxies,
  };
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  config.publicUrl = "https://overseer.example.test";
  config.githubClientId = "direct-kamal-client";
  config.githubClientSecret = "direct-kamal-secret";
  config.githubNativeCallbacks = ["overseer://oauth/github"];
  config.trustedProxies = ["loopback", "linklocal", "uniquelocal"];

  const { port, server } = await listen();
  try {
    // Exact current direct-Kamal chain: the trusted app socket peer is
    // loopback/private, while Kamal's appended external TCP peer is the
    // rightmost XFF address. Changing or corrupting values farther left cannot
    // rotate the public abuse-limit subject.
    for (let index = 0; index < 11; index += 1) {
      const response = await post(
        port,
        "/api/auth/github/native/start",
        { callback: "overseer://oauth/github" },
        directKamalHeaders(index),
      );
      assert.equal(response.status, index < 10 ? 200 : 429);
      if (index === 10) assert.equal(response.body.code, "RATE_LIMITED");
    }
    // Fail closed even if a future/broken proxy emits a malformed rightmost
    // token: clientInfo rejects it as an IP and uses the one trusted socket peer.
    for (let index = 0; index < 21; index += 1) {
      const response = await post(
        port,
        "/api/auth/github/native/exchange",
        { state: `state-${index}`, code: `code-${index}` },
        malformedRightmostHeaders(index),
      );
      assert.equal(response.status, index < 20 ? 400 : 429);
      assert.equal(response.body.code, index < 20 ? "BAD_APP_CODE" : "RATE_LIMITED");
    }
  } finally {
    await close(server);
    Object.assign(config, original);
  }
});

test("a validated proxy chain selects the first untrusted XFF address and rejects invalid proxy configuration", async () => {
  const original = {
    githubClientId: config.githubClientId,
    githubClientSecret: config.githubClientSecret,
    trustedProxies: config.trustedProxies,
  };
  config.githubClientId = "trusted-chain-client";
  config.githubClientSecret = "trusted-chain-secret";
  config.trustedProxies = ["loopback", "192.0.2.0/24"];
  const { port, server } = await listen();
  try {
    for (let index = 0; index < 11; index += 1) {
      const response = await post(port, "/api/auth/github/start", {}, {
        // 192.0.2.10 is a configured intermediate proxy. The distinct address
        // to its left is the first untrusted hop and therefore the client.
        "x-forwarded-for": `198.51.100.${index + 1}, 192.0.2.10`,
        // The application never consumes this header directly.
        "cf-connecting-ip": "203.0.113.99",
      });
      assert.equal(response.status, 200);
    }
  } finally {
    await close(server);
  }

  try {
    config.trustedProxies = ["not-an-ip-or-named-range"];
    assert.throws(() => createServer(), /invalid IP address/);
  } finally {
    Object.assign(config, original);
  }
});

test("deployment configs canonicalize Cloudflare identity before the application trust boundary", () => {
  const productionNginx = readFileSync(
    path.join(repositoryRoot, "apps/server/config/nginx/overseer.rnm.dev.conf"),
    "utf8",
  );
  const developmentNginx = readFileSync(
    path.join(repositoryRoot, "apps/server/config/nginx/overseer-dev.rnm.dev.conf"),
    "utf8",
  );
  const deploy = readFileSync(path.join(repositoryRoot, "apps/server/config/deploy.yml"), "utf8");
  const compose = readFileSync(path.join(repositoryRoot, "docker-compose.yml"), "utf8");
  const documentationIndex = readFileSync(path.join(repositoryRoot, "docs/index.md"), "utf8");
  const runbook = readFileSync(path.join(repositoryRoot, "docs/deploy-runbook.md"), "utf8");
  const proxyTrust = readFileSync(path.join(repositoryRoot, "docs/proxy-trust.md"), "utf8");
  const threatModel = readFileSync(
    path.join(repositoryRoot, "docs/reverse-fleet-security.md"),
    "utf8",
  );

  for (const nginx of [productionNginx, developmentNginx]) {
    assert.match(nginx, /real_ip_header CF-Connecting-IP;/);
    assert.deepEqual(
      [...nginx.matchAll(/^set_real_ip_from ([^;]+);$/gm)].map((match) => match[1]),
      cloudflareCidrs,
    );
    assert.match(nginx, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/);
    assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/);
  }
  assert.match(deploy, /OVERSEER_TRUSTED_PROXIES: loopback,linklocal,uniquelocal/);
  assert.match(deploy, /^minimum_version: 2\.12\.0$/m);
  assert.match(deploy, /^\s{4}repository: basecamp\/kamal-proxy$/m);
  assert.match(deploy, /^\s{4}version: v0\.9\.2$/m);
  assert.match(deploy, /^\s{4}http_port: 8080$/m);
  assert.match(deploy, /^\s{4}https_port: 8443$/m);
  assert.match(deploy, /^\s{4}publish: true$/m);
  assert.match(deploy, /^\s{6}- 127\.0\.0\.1$/m);
  assert.doesNotMatch(deploy, /^\s{6}- (?:0\.0\.0\.0|::)$/m);
  assert.match(compose, /OVERSEER_TRUSTED_PROXIES: \$\{OVERSEER_TRUSTED_PROXIES:-loopback,linklocal,uniquelocal\}/);
  for (const documentation of [documentationIndex, proxyTrust, runbook, threatModel]) {
    const normalized = documentation.replace(/\s+/g, " ");
    assert.match(
      normalized,
      /production Kamal listeners were wildcard host-bound on both 8080 and 8443 \(`0\.0\.0\.0\/\[::\]`\)/,
    );
    assert.match(normalized, /external request to 8080 returned HTTP 200/);
    assert.match(
      normalized,
      /8443 probe timed out with no HTTP response \(possibly filtered\), so only 8080 was demonstrated Internet-reachable/,
    );
    assert.doesNotMatch(normalized, /publicly reachable on 8080\/8443/);
  }
  assert.match(proxyTrust, /both direct requests below must fail to\s+connect/);
  assert.match(runbook, /Any HTTP response is failure: direct Kamal ingress still exists/);
  assert.match(runbook, /http:\/\/127\.0\.0\.1:8080\/healthz/);
  assert.match(runbook, /kamal config -c "\$OVSR_PROXY_ROLLBACK_YML"/);
  assert.match(runbook, /kamal proxy reboot -c "\$OVSR_PROXY_ROLLBACK_YML"/);
  assert.match(runbook, /sha256sum -c SHA256SUMS/);
  assert.match(runbook, /reopens the independently verified direct 8080 boundary/);
});
