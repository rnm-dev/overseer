import { EventEmitter } from "node:events";
const emitter = new EventEmitter();
export const sessionWarnings = {
    publish(warning) {
        emitter.emit("warning", warning);
    },
    subscribe(listener) {
        emitter.on("warning", listener);
        return () => emitter.off("warning", listener);
    },
};
