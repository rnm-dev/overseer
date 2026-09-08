import type { Readable, Writable } from "node:stream";

export const MAX_FRAME_BYTES = 64 * 1024;

/** Private inherited pipes only. No socket, arbitrary method dispatch or credentials. */
export function servePipe(
  input: Readable,
  output: Writable,
  handle: (method: string, params: unknown) => Promise<unknown>,
  close: () => void,
): void {
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();
  let pending = 0;
  let closed = false;
  const fail = () => { if (!closed) { closed = true; close(); } };
  input.on("end", fail);
  input.on("error", fail);
  output.on("error", fail);
  input.on("data", (chunk: Buffer) => {
    if (closed) return;
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const end = buffer.indexOf(10);
      if (end < 0) { if (buffer.length > MAX_FRAME_BYTES) fail(); return; }
      if (end > MAX_FRAME_BYTES || pending >= 16) { fail(); return; }
      const frame = buffer.subarray(0, end).toString("utf8");
      buffer = buffer.subarray(end + 1);
      let request: { id: number; method: string; params?: unknown };
      try {
        request = JSON.parse(frame);
        if (!request || !Number.isSafeInteger(request.id) || request.id < 0 || typeof request.method !== "string") throw new Error();
      } catch { fail(); return; }
      pending++;
      chain = chain.then(async () => {
        if (closed) return;
        let response: object;
        try { response = { id: request.id, result: await handle(request.method, request.params) }; }
        catch (error) {
          const code = (error as { code?: unknown })?.code;
          // Messages from providers, settings or OS exceptions can contain secrets/paths.
          response = { id: request.id, error: typeof code === "string" && /^[A-Z_]{1,48}$/.test(code) ? code : "REQUEST_FAILED" };
        }
        const encoded = Buffer.from(JSON.stringify(response) + "\n");
        if (encoded.length > MAX_FRAME_BYTES) { fail(); return; }
        await new Promise<void>((resolve, reject) => output.write(encoded, error => error ? reject(error) : resolve()));
      }).catch(fail).finally(() => { pending--; });
    }
  });
}
