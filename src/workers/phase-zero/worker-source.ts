/** Immutable local source that the production build embeds in main.js. */
export const PHASE_ZERO_WORKER_SOURCE = String.raw`"use strict";
const PROTOCOL_VERSION = 1;
const MAX_REQUEST_BYTES = 1048576;
const MIN_CHUNK_BYTES = 1;
const cancelled = new Set();

function postFailure(kind, requestId, message) {
  self.postMessage({ protocolVersion: PROTOCOL_VERSION, kind, requestId, message });
}

function processChunk(state) {
  if (cancelled.delete(state.requestId)) {
    postFailure("cancelled", state.requestId);
    return;
  }
  const end = Math.min(state.index + state.chunkBytes, state.output.length);
  for (let index = state.index; index < end; index += 1) {
    state.output[index] = state.input[index] ^ 255;
  }
  state.index = end;
  if (state.index < state.output.length) {
    setTimeout(() => processChunk(state), 0);
    return;
  }
  const payload = state.output.buffer;
  self.postMessage({
    protocolVersion: PROTOCOL_VERSION,
    kind: "complete",
    requestId: state.requestId,
    revision: state.revision,
    byteLength: payload.byteLength,
    payload,
  }, [payload]);
}

self.addEventListener("message", (event) => {
  const request = event.data;
  if (request && request.protocolVersion === PROTOCOL_VERSION && request.kind === "cancel") {
    cancelled.add(request.requestId);
    return;
  }
  if (!request || request.protocolVersion !== PROTOCOL_VERSION || request.kind !== "transform") {
    postFailure("error", request && request.requestId || 0, "Unsupported request.");
    return;
  }
  if (!(request.payload instanceof ArrayBuffer) || request.byteLength !== request.payload.byteLength ||
      request.byteLength > MAX_REQUEST_BYTES || request.chunkBytes < MIN_CHUNK_BYTES) {
    postFailure("error", request.requestId, "Invalid request bounds.");
    return;
  }
  const input = new Uint8Array(request.payload);
  processChunk({
    requestId: request.requestId,
    revision: request.revision,
    chunkBytes: request.chunkBytes,
    input,
    output: new Uint8Array(input.length),
    index: 0,
  });
});`;
