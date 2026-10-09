import assert from "node:assert/strict";
import test from "node:test";
import { ResourceSampler, RESOURCE_USAGE_CAPABILITY } from "../http/fleet/resources.js";

test("resource sampler returns bounded, path-free host, process and disk metrics", async () => {
  const sample = await new ResourceSampler().sample();
  assert.equal(sample.version, RESOURCE_USAGE_CAPABILITY);
  assert.ok(sample.sampledAt > 0);
  assert.ok(sample.sequence > 0);
  assert.ok(sample.host.cpuPercent >= 0 && sample.host.cpuPercent <= 100);
  assert.equal(sample.host.cpuPercent, 0);
  assert.equal(sample.process.cpuPercent, 0);
  assert.ok(sample.host.logicalCpuCount >= 1);
  assert.ok(sample.host.memoryTotalBytes > 0);
  assert.ok(sample.process.rssBytes > 0);
  assert.ok(sample.disk.totalBytes > 0);
  assert.ok(sample.disk.availableBytes >= 0);
  assert.ok(sample.disk.usedPercent >= 0 && sample.disk.usedPercent <= 100);
  assert.equal(JSON.stringify(sample).includes(process.cwd()), false);
});
