import { sha256 } from "@noble/hashes/sha2.js";

import { parseSha256Digest } from "../note-session";
import { SOURCE_COORDINATION_LIMITS_V1 } from "./limits";
import type { StreamingSha256PortV1, StreamingSha256SinkV1 } from "./types";
import type {
  SourceDigestWorkPortV1,
  SourceDigestWorkSubmissionV1,
} from "./work-ports";

const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;

export function createStreamingSha256PortV1(): StreamingSha256PortV1 {
  return Object.freeze({
    create(): StreamingSha256SinkV1 {
      const hasher = sha256.create();
      let finished = false;
      return Object.freeze({
        dispose(): void {
          hasher.destroy();
          finished = true;
        },
        async finish() {
          if (finished) throw new Error("The digest sink is already closed.");
          finished = true;
          return parseSha256Digest(bytesToHex(hasher.digest()));
        },
        update(chunk: Uint8Array): void {
          if (finished) throw new Error("The digest sink is already closed.");
          hasher.update(chunk);
        },
      });
    },
  });
}

export function createSourceDigestStreamingSha256PortV1(
  workPort: SourceDigestWorkPortV1,
): StreamingSha256PortV1 {
  return Object.freeze({
    create(): StreamingSha256SinkV1 {
      return createSourceDigestSink(workPort.submit());
    },
  });
}

function createSourceDigestSink(
  submission: SourceDigestWorkSubmissionV1,
): StreamingSha256SinkV1 {
  let state: "open" | "closing" | "finished" | "disposed" = "open";
  const cancel = (): void => {
    if (state === "disposed" || state === "finished") return;
    state = "disposed";
    try {
      submission.cancel();
    } catch {
      // The sink remains closed even if transport cancellation fails.
    }
  };
  return Object.freeze({
    dispose: cancel,
    async finish() {
      if (state !== "open") throw new Error("The digest sink is closed.");
      state = "closing";
      try {
        submission.closeInput();
        const result = await submission.completion;
        if (!result.ok) throw new Error("Digest work failed.");
        state = "finished";
        return parseSha256Digest(result.value);
      } catch (error) {
        cancel();
        throw error;
      }
    },
    async update(chunk: Uint8Array) {
      if (state !== "open") throw new Error("The digest sink is closed.");
      if (
        chunk.byteLength >
        SOURCE_COORDINATION_LIMITS_V1.maxStreamingDigestChunkBytes
      ) {
        cancel();
        throw new RangeError("Digest chunks are limited to 256 KiB.");
      }
      try {
        await submission.update(chunk);
      } catch (error) {
        cancel();
        throw error;
      }
    },
  });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) =>
    byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0"),
  ).join("");
}
