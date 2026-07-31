import { BoundedDiagnostics } from "./diagnostics.js";

export class TopologyViolation extends Error {
  constructor(message) {
    super(message);
    this.code = "INBOUND_PEON_DIAL";
  }
}

export class NoInboundTopology {
  constructor(options = {}) {
    this.diagnostics = options.diagnostics ?? new BoundedDiagnostics();
    this.peonFleetPortBlocked = options.peonFleetPortBlocked ?? true;
    this.connections = new Set();
    this.inboundAttempts = [];
  }

  openConnection({ initiator, target, channel }) {
    if (initiator !== "peon" || target !== "overseer") {
      const attempt = { initiator, target, channel };
      this.inboundAttempts.push(attempt);
      this.diagnostics.add("forbidden_inbound_attempt", attempt);
      throw new TopologyViolation(`Overseer attempted inbound Peon connection on ${channel}`);
    }
    if (channel !== "control") throw new Error(`unknown reverse channel ${channel}`);
    this.connections.add(channel);
    this.diagnostics.add("outbound_connection_opened", { initiator, target, channel });
  }

  exercise(surface, route) {
    if (route !== "reverse-socket") {
      if (route === "legacy-http" && [
        "absolute-folder-picker", "project-directory", "project-file-read",
        "sandbox-file-read", "project-file-upload", "attachment-upload",
        "project-file-move", "project-file-delete",
      ].includes(surface)) {
        this.diagnostics.add("fleet_http_surface_exercised", { surface, channel: "mesh" });
        return;
      }
      if (this.peonFleetPortBlocked && route === "legacy-http") {
        this.inboundAttempts.push({ initiator: "overseer", target: "peon", channel: surface });
        throw new TopologyViolation(`${surface} selected legacy HTTP while the Peon fleet port is blocked`);
      }
      throw new Error(`${surface} is not operable through the reverse topology: ${route}`);
    }
    const channel = "control";
    if (!this.connections.has(channel)) throw new Error(`${channel} reverse connection is not open`);
    this.diagnostics.add("reverse_surface_exercised", { surface, channel });
  }

  assertNoInboundAttempts() {
    if (this.inboundAttempts.length > 0) {
      throw new TopologyViolation(`${this.inboundAttempts.length} inbound Peon connection attempt(s) observed`);
    }
    return true;
  }
}
