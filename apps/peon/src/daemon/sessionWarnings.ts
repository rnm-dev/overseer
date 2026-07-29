import { EventEmitter } from "node:events";
import type { SessionWarning } from "./sessionWarningTypes.js";

const emitter = new EventEmitter();

export const sessionWarnings = {
  publish(warning: SessionWarning): void {
    emitter.emit("warning", warning);
  },
  subscribe(listener: (warning: SessionWarning) => void): () => void {
    emitter.on("warning", listener);
    return () => emitter.off("warning", listener);
  },
};
