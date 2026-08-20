import { describe, expect, it } from "vitest";

import type {
  CommandResultV1,
  Sha256Digest,
} from "../../../src/application/note-session";
import { SOURCE_COORDINATION_LIMITS_V1 } from "../../../src/application/source-coordination/limits";
import {
  encodedSourceOffsetMapBytes,
  identifySourceOffsetMap,
} from "../../../src/application/source-coordination/offset-map";
import {
  createSourceDigestStreamingSha256PortV1,
  createStreamingSha256PortV1,
} from "../../../src/application/source-coordination/sha256-port";
import type {
  SourceDigestWorkPortV1,
  SourceDigestWorkSubmissionV1,
} from "../../../src/application/source-coordination/work-ports";
import {
  ImmediateSourceDigestWorkPort,
  TestStreamingDigestPort,
  digestUtf8,
} from "./support";

const LARGE_MAP_SPAN_COUNT = 8_192;
const MAP_SPAN_STRIDE = 2;

class ControlledDigestPort implements SourceDigestWorkPortV1 {
  cancelled = 0;
  closed = 0;
  readonly chunks: Uint8Array[] = [];
  completion: Promise<CommandResultV1<Sha256Digest>>;
  reject!: (error: unknown) => void;
  resolve!: (result: CommandResultV1<Sha256Digest>) => void;

  constructor() {
    this.completion = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  submit(): SourceDigestWorkSubmissionV1 {
    return {
      cancel: (): void => {
        this.cancelled += 1;
      },
      closeInput: (): void => {
        this.closed += 1;
      },
      completion: this.completion,
      update: (chunk): void => {
        this.chunks.push(chunk);
      },
    };
  }
}

describe("production streaming SHA-256 port", () => {
  it("hashes incremental bytes and closes the sink after completion", async () => {
    const sink = createStreamingSha256PortV1().create();
    await sink.update(new TextEncoder().encode("stream"));
    await sink.update(new TextEncoder().encode("ing"));

    await expect(sink.finish()).resolves.toBe(digestUtf8("streaming"));
    expect(() => sink.update(new Uint8Array([1]))).toThrow();
    await expect(sink.finish()).rejects.toThrow();
    expect(() => sink.dispose?.()).not.toThrow();
  });

  it("streams map-digest bytes through the injected work port", async () => {
    const work = new ControlledDigestPort();
    const sink = createSourceDigestStreamingSha256PortV1(work).create();
    const first = new TextEncoder().encode("canonical-");
    const second = new TextEncoder().encode("map");

    await sink.update(first);
    await sink.update(second);
    const completed = sink.finish();
    work.resolve({ ok: true, value: digestUtf8("canonical-map") });

    await expect(completed).resolves.toBe(digestUtf8("canonical-map"));
    expect(work.chunks).toEqual([first, second]);
    expect(work.closed).toBe(1);
    expect(work.cancelled).toBe(0);
    expect(() => sink.dispose?.()).not.toThrow();
  });
});

describe("source digest streaming SHA-256 adapter", () => {
  it("keeps an above-admission canonical map digest off the direct port", async () => {
    const spans = Array.from({ length: LARGE_MAP_SPAN_COUNT }, (_, index) => ({
      newFromUtf16: index * MAP_SPAN_STRIDE,
      newToUtf16: index * MAP_SPAN_STRIDE + 1,
      oldFromUtf16: index * MAP_SPAN_STRIDE,
      oldToUtf16: index * MAP_SPAN_STRIDE + 1,
    }));
    const offsetMap = { spans };
    const length = LARGE_MAP_SPAN_COUNT * MAP_SPAN_STRIDE;
    expect(
      encodedSourceOffsetMapBytes(offsetMap, length, length),
    ).toBeGreaterThan(
      SOURCE_COORDINATION_LIMITS_V1.sourceDigestWorkerAdmissionBytes,
    );
    const work = new ImmediateSourceDigestWorkPort();
    const workerResult = await identifySourceOffsetMap(
      createSourceDigestStreamingSha256PortV1(work),
      offsetMap,
      length,
      length,
    );
    const directResult = await identifySourceOffsetMap(
      new TestStreamingDigestPort(),
      offsetMap,
      length,
      length,
    );

    expect(workerResult).toEqual(directResult);
    expect(work.submissions).toBe(1);
    expect(
      work.chunkSizes.every(
        (size) =>
          size <= SOURCE_COORDINATION_LIMITS_V1.maxStreamingDigestChunkBytes,
      ),
    ).toBe(true);
  });

  it("admits the exact chunk bound and cancels above it", async () => {
    const atLimitWork = new ControlledDigestPort();
    const atLimit =
      createSourceDigestStreamingSha256PortV1(atLimitWork).create();
    await expect(
      atLimit.update(
        new Uint8Array(
          SOURCE_COORDINATION_LIMITS_V1.maxStreamingDigestChunkBytes,
        ),
      ),
    ).resolves.toBeUndefined();
    atLimit.dispose?.();
    expect(atLimitWork.cancelled).toBe(1);

    const aboveWork = new ControlledDigestPort();
    const above = createSourceDigestStreamingSha256PortV1(aboveWork).create();
    await expect(
      above.update(
        new Uint8Array(
          SOURCE_COORDINATION_LIMITS_V1.maxStreamingDigestChunkBytes + 1,
        ),
      ),
    ).rejects.toThrow("256 KiB");
    expect(aboveWork.chunks).toHaveLength(0);
    expect(aboveWork.cancelled).toBe(1);
    await expect(above.finish()).rejects.toThrow("closed");
  });

  it("cancels failed work and disposes an open sink idempotently", async () => {
    const failedWork = new ControlledDigestPort();
    const failed = createSourceDigestStreamingSha256PortV1(failedWork).create();
    const completion = failed.finish();
    failedWork.reject(new Error("Injected work failure."));
    await expect(completion).rejects.toThrow("Injected work failure.");
    expect(failedWork.cancelled).toBe(1);

    const disposedWork = new ControlledDigestPort();
    const disposed =
      createSourceDigestStreamingSha256PortV1(disposedWork).create();
    disposed.dispose?.();
    disposed.dispose?.();
    expect(disposedWork.cancelled).toBe(1);
    await expect(disposed.update(new Uint8Array())).rejects.toThrow("closed");
  });
});
