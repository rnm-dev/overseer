import assert from "node:assert/strict";
import { test } from "node:test";
import type express from "express";
import { WebSocket } from "ws";
import { send } from "./liveSocket.js";
import { writeProjectedTranscriptSseEvent } from "./routes/peons/sessions.js";

test("a slow browser WebSocket is terminated before another transcript frame is queued", () => {
  let terminated = 0;
  let sent = 0;
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: (8 * 1024 * 1024) + 1,
    terminate: () => {
      terminated += 1;
    },
    send: () => {
      sent += 1;
    },
  };
  assert.equal(send(socket as unknown as WebSocket, { type: "tail" }), false);
  assert.equal(terminated, 1);
  assert.equal(sent, 0);
});

test("a slow SSE transcript client is ended before another frame is queued", () => {
  let ended = 0;
  let writes = 0;
  const response = {
    writableEnded: false,
    writableLength: (8 * 1024 * 1024) + 1,
    end: () => {
      ended += 1;
      return response;
    },
    write: () => {
      writes += 1;
      return true;
    },
  };
  assert.equal(
    writeProjectedTranscriptSseEvent(
      response as unknown as Pick<
        express.Response,
        "writableEnded" | "writableLength" | "write" | "end"
      >,
      { eventId: "event-slow", type: "assistant" },
      new Set<string>(),
    ),
    false,
  );
  assert.equal(ended, 1);
  assert.equal(writes, 0);

  const backpressured = {
    writableEnded: false,
    writableLength: 1,
    end: () => {
      ended += 1;
      return backpressured;
    },
    write: () => {
      writes += 1;
      return false;
    },
  };
  assert.equal(
    writeProjectedTranscriptSseEvent(
      backpressured as unknown as Pick<
        express.Response,
        "writableEnded" | "writableLength" | "write" | "end"
      >,
      { eventId: "event-backpressure", type: "assistant" },
      new Set<string>(),
    ),
    false,
  );
  assert.equal(ended, 2);
  assert.equal(writes, 1);
});
