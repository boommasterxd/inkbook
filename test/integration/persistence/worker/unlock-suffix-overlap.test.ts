import { describe, expect, it } from "vitest";
import { ChunkedInkbookInputParser } from "../../../../src/persistence/serialization/input/chunked-input-codec";
import {
  createOneStrokeWorkerSnapshot,
  createWorkerBridgeClient,
  createWorkerBridgeHarness,
  createWorkerUnlockRequest,
} from "../../../fixtures/persistence/worker-bridge";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";

function serialized(): string {
  const output = serializeInkbookDocument(createOneStrokeWorkerSnapshot());
  if (!output.ok) throw new Error(output.error.message);
  return output.value.svg;
}

function pendingAdoptionUntilAbort(signal: AbortSignal, onAbort: () => void): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => {
        onAbort();
        reject(new Error("Adoption cancelled."));
      },
      { once: true },
    );
  });
}

describe("unlock suffix and staged adoption", () => {
  it("checks the complete suffix while adoption is pending and delays success until adoption drains", async () => {
    let release!: () => void;
    let adoptionStarted = false;
    const adoption = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parser = new ChunkedInkbookInputParser({
      onValidatedSnapshot: () => {
        adoptionStarted = true;
        return adoption;
      },
    });
    expect((await parser.write(new TextEncoder().encode(serialized()))).ok).toBe(true);
    expect(adoptionStarted).toBe(true);
    let finished = false;
    const finishing = parser.finish().then((result) => {
      finished = true;
      return result;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    expect((await finishing).ok).toBe(true);
  });

  it("aborts staged adoption on an unsafe suffix before any success result", async () => {
    let adoptionStarted = false;
    let aborted = false;
    const parser = new ChunkedInkbookInputParser({
      onValidatedSnapshot: (_snapshot, _derivations, signal) => {
        adoptionStarted = true;
        return pendingAdoptionUntilAbort(signal, () => {
          aborted = true;
        });
      },
    });
    const malicious = serialized().replace("</svg>", "<script>unsafe()</script></svg>");
    const written = await parser.write(new TextEncoder().encode(malicious));
    expect(adoptionStarted).toBe(true);
    expect(written.ok).toBe(false);
    expect((await parser.finish()).ok).toBe(false);
    expect(aborted).toBe(true);
  });

  it("propagates adoption failure and cancellation without completing a model", async () => {
    const failed = new ChunkedInkbookInputParser({
      onValidatedSnapshot: async () => {
        throw new Error("adoption failed");
      },
    });
    await failed.write(new TextEncoder().encode(serialized()));
    await expect(failed.finish()).rejects.toThrow("adoption failed");
    const controller = new AbortController();
    let aborted = false;
    const cancelled = new ChunkedInkbookInputParser({
      signal: controller.signal,
      onValidatedSnapshot: (_snapshot, _derivations, signal) => {
        return pendingAdoptionUntilAbort(signal, () => {
          aborted = true;
        });
      },
    });
    await cancelled.write(new TextEncoder().encode(serialized()));
    controller.abort();
    await expect(cancelled.finish()).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});

describe("unlock acknowledgement backpressure", () => {
  it("retains one bounded batch while adoption is blocked and publishes the terminal header last", async () => {
    const elements = Array.from({ length: 513 }, (_, index) => ({
      ...createTestStroke(),
      id: `00000000-0000-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
    }));
    const output = serializeInkbookDocument(createWorkerSnapshot(elements));
    if (!output.ok) throw new Error(output.error.message);
    const harness = createWorkerBridgeHarness();
    const client = createWorkerBridgeClient(harness.clientEndpoint);
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = new Promise<void>((resolve) => {
      started = resolve;
    });
    const batches: number[] = [];
    try {
      const pending = client.execute(
        createWorkerUnlockRequest(new TextEncoder().encode(output.value.svg)),
        {
          unlockBatch: async (batch) => {
            batches.push(batch.elements.length);
            if (batch.batchIndex === 0) {
              started();
              await held;
            }
          },
        },
      );
      await first;
      await Promise.resolve();
      expect(
        harness.hostEndpoint.sentMessages.filter(
          (message) => (message as { type: string }).type === "inkbook-worker-unlock-batch",
        ),
      ).toHaveLength(1);
      expect(
        harness.hostEndpoint.sentMessages.some(
          (message) => (message as { type: string }).type === "inkbook-worker-result",
        ),
      ).toBe(false);
      expect(batches).toEqual([256]);
      release();
      expect(await pending).toMatchObject({
        type: "unlock-success",
        snapshot: { batchCount: 3, elementCount: 513 },
      });
      expect(batches).toEqual([256, 256, 1]);
    } finally {
      release();
      client.terminate();
      harness.detach();
      harness.runtime.terminate();
    }
  });
});
