const CANONICAL_PAIR = ["session-catalog-v1", "durable-delivery-v1"];

function intersection(left = [], right = []) {
  const accepted = new Set(right);
  return left.filter((value) => accepted.has(value));
}

function feature(profile, channel, name) {
  return profile.channelFeatures?.[channel]?.includes(name) === true;
}

export function negotiateCapabilities(peon, overseer) {
  let control = intersection(peon.controlCapabilities, overseer.controlCapabilities);
  const hasCanonicalPair = CANONICAL_PAIR.every((capability) => control.includes(capability));
  if (!hasCanonicalPair) {
    control = control.filter((capability) => !CANONICAL_PAIR.includes(capability) && capability !== "project-catalog-v1");
  }
  if (!control.includes("session-catalog-v1")) {
    control = control.filter((capability) => capability !== "project-catalog-v1");
  }
  const transfer = intersection(peon.transferCapabilities, overseer.transferCapabilities);
  const channelFeatures = {};
  if (control.includes("folder-listing-v1")
    && feature(peon, "folder-listing-v1", "entry-metadata-v1")
    && feature(overseer, "folder-listing-v1", "entry-metadata-v1")) {
    channelFeatures["folder-listing-v1"] = ["entry-metadata-v1"];
  }
  return { control, transfer, channelFeatures };
}

export function routeForSurface(surface, negotiated) {
  const control = new Set(negotiated.control);
  const transfer = new Set(negotiated.transfer);
  const folderMetadata = negotiated.channelFeatures["folder-listing-v1"]?.includes("entry-metadata-v1") === true;
  switch (surface) {
    case "socket-presence":
      return "reverse-socket";
    case "session-catalog":
      return CANONICAL_PAIR.every((capability) => control.has(capability)) ? "reverse-socket" : "legacy-http";
    case "project-catalog":
      return control.has("project-catalog-v1") && CANONICAL_PAIR.every((capability) => control.has(capability))
        ? "reverse-socket" : "legacy-http";
    case "absolute-folder-picker":
      return control.has("folder-listing-v1") ? "reverse-socket" : "unavailable";
    case "project-directory":
      return control.has("folder-listing-v1") && folderMetadata ? "reverse-socket" : "legacy-http";
    case "project-file-read":
      return transfer.has("project-file-read-v1") ? "reverse-socket" : "legacy-http";
    case "sandbox-file-read":
      return transfer.has("sandbox-file-read-v1") ? "reverse-socket" : "legacy-http";
    default:
      return "unimplemented";
  }
}

export function runCapabilityMatrix(document) {
  const profiles = document.profiles ?? {};
  const cells = [];
  for (const expected of document.cells ?? []) {
    const peon = profiles.peon?.[expected.peon];
    const overseer = profiles.overseer?.[expected.overseer];
    if (!peon || !overseer) {
      cells.push({ ...expected, passed: false, errors: ["unknown matrix profile"] });
      continue;
    }
    const negotiated = negotiateCapabilities(peon, overseer);
    const routes = Object.fromEntries(
      Object.keys(expected.routes).map((surface) => [surface, routeForSurface(surface, negotiated)]),
    );
    const errors = [];
    for (const [surface, route] of Object.entries(expected.routes)) {
      if (routes[surface] !== route) errors.push(`${surface}: expected ${route}, got ${routes[surface]}`);
    }
    cells.push({
      peon: expected.peon,
      overseer: expected.overseer,
      negotiated,
      routes,
      passed: errors.length === 0,
      errors,
    });
  }
  const extensions = (document.extensions ?? []).map((extension) => ({
    ...extension,
    passed: false,
    blocked: true,
  }));
  return {
    formatVersion: 1,
    passed: cells.filter((cell) => cell.passed).length,
    failed: cells.filter((cell) => !cell.passed).length,
    cells,
    extensions,
  };
}
