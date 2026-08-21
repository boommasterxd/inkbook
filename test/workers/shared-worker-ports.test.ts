/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact protocol and scheduler boundaries are intentional. */
import { expect, it } from "vitest";

import {
  createPersistenceEncodeWorkV1,
  createPersistenceParseWorkV1,
  encodeInkbookSidecarV1,
} from "../../src/application/persistence";
import { validateAndNormalizeSourceMapCompositionRequestV1 } from "../../src/application/source-coordination/map-composition-fallback";
import { SchedulerPersistenceCodecPortV1 } from "../../src/workers/persistence-codec-port";
import { ByteWorkerScheduler } from "../../src/workers/scheduler/scheduler";
import { createSharedWorkerPortsV1 } from "../../src/workers/shared-worker-ports";
import { SchedulerSourceDigestWorkPortV1 } from "../../src/workers/source-digest-port";
import { SchedulerSourceMapWorkPortV1 } from "../../src/workers/source-map-port";
import { completeSidecar } from "../application/persistence/support";
import { ManualSlices } from "./scheduler/support";

const REVISION = { scene: 4, layout: 8 };
const MAX_INPUT_BYTES = 16_777_216;
const MAX_RESERVED_BYTES = 167_772_160;
const MICROTASK_TURNS = 8;

function fallbackHarness(): {
  readonly scheduler: ByteWorkerScheduler;
  readonly slices: ManualSlices;
} {
  let time = 0;
  const slices = new ManualSlices();
  return {
    slices,
    scheduler: new ByteWorkerScheduler({
      launchWorker: (): undefined => undefined,
      clock: { now: (): number => time++ },
      slices,
      isCurrent: (): boolean => true,
      maxOutstandingBytes: MAX_INPUT_BYTES,
      maxReservedBytes: MAX_RESERVED_BYTES,
    }),
  };
}

async function flushChainedWork(slices: ManualSlices): Promise<void> {
  for (let turn = 0; turn < MICROTASK_TURNS; turn += 1) {
    slices.flushAll();
    await Promise.resolve();
  }
}

it("creates exactly one fallback scheduler when the worker platform is unavailable", () => {
  const slices = new ManualSlices();
  const ports = createSharedWorkerPortsV1({
    environment: null,
    clock: { now: (): number => 0 },
    slices,
    readRevision: () => REVISION,
    isCurrent: (): boolean => true,
  });

  expect(ports.sourceDigest).toBeDefined();
  expect(ports.sourceMapWork).toBeDefined();
  expect(ports.persistenceCodec).toBeDefined();
  ports.dispose();
  ports.dispose();
});

it("runs semantic digest work through identical bounded fallback phases", async () => {
  const { scheduler, slices } = fallbackHarness();
  const port = new SchedulerSourceDigestWorkPortV1(scheduler, () => REVISION);
  const submission = port.submit();
  const canonical = new TextEncoder().encode("abc");
  const update = submission.update(canonical);
  submission.closeInput();
  await flushChainedWork(slices);
  await update;

  await expect(submission.completion).resolves.toEqual({
    ok: true,
    value: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  });
  expect(new TextDecoder().decode(canonical)).toBe("abc");
  scheduler.dispose();
});

it("cancels digest state and rejects without waiting for another slice", async () => {
  const { scheduler, slices } = fallbackHarness();
  const port = new SchedulerSourceDigestWorkPortV1(scheduler, () => REVISION);
  const submission = port.submit();
  submission.cancel();

  await expect(submission.completion).rejects.toMatchObject({
    name: "AbortError",
  });
  slices.flushAll();
  scheduler.dispose();
});

it("runs source-map composition and compaction through the same port", async () => {
  const { scheduler, slices } = fallbackHarness();
  const port = new SchedulerSourceMapWorkPortV1(scheduler, () => REVISION);
  const request = validateAndNormalizeSourceMapCompositionRequestV1({
    wireVersion: 1,
    priorUtf16Length: 2,
    replacementUtf16Length: 3,
    scratchByteLimit: 8_388_608,
    segments: [
      {
        priorUtf16Length: 2,
        replacementUtf16Length: 3,
        offsetMap: {
          spans: [
            {
              oldFromUtf16: 1,
              oldToUtf16: 1,
              newFromUtf16: 1,
              newToUtf16: 2,
            },
          ],
        },
      },
    ],
  });
  if (!request.ok) throw new Error("Source map fixture is invalid.");
  const submission = port.submit(request.value);
  slices.flushAll();

  await expect(submission.completion).resolves.toEqual({
    ok: true,
    value: request.value.segments[0]?.offsetMap,
  });
  const compacted = port.submit(request.value);
  slices.flushAll();
  await expect(compacted.completion).resolves.toEqual({
    ok: true,
    value: request.value.segments[0]?.offsetMap,
  });
  expect(slices.modes).toContain("idle");
  scheduler.dispose();
});

it("parses a canonical sidecar with the shared persistence fallback", async () => {
  const { scheduler, slices } = fallbackHarness();
  const port = new SchedulerPersistenceCodecPortV1(scheduler, () => REVISION);
  const sidecar = completeSidecar();
  const bytes = encodeInkbookSidecarV1(sidecar, "phone");
  const rawText = new TextDecoder().decode(bytes);
  const submission = port.submit(
    createPersistenceParseWorkV1(rawText, bytes.byteLength, 1_048_576),
  );
  slices.flushAll();

  await expect(submission.result).resolves.toMatchObject({
    wireVersion: 1,
    kind: "parsed-sidecar",
    value: { kind: "current", sidecar },
  });
  scheduler.dispose();
});

it("encodes a canonical sidecar across bounded persistence fallback slices", async () => {
  const { scheduler, slices } = fallbackHarness();
  const port = new SchedulerPersistenceCodecPortV1(scheduler, () => REVISION);
  const sidecar = completeSidecar();
  const expected = encodeInkbookSidecarV1(sidecar, "phone");
  const submission = port.submit(
    createPersistenceEncodeWorkV1(
      sidecar,
      "phone",
      1_048_576,
      expected.byteLength,
    ),
  );
  slices.flushAll();

  await expect(submission.result).resolves.toMatchObject({
    wireVersion: 1,
    kind: "encoded-sidecar",
    bytes: expected,
  });
  expect(slices.modes.filter((mode) => mode === "idle").length).toBeGreaterThan(
    1,
  );
  scheduler.dispose();
});

it("publishes no cache on cancellation and retains completed per-note entries", async () => {
  const { scheduler, slices } = fallbackHarness();
  const port = new SchedulerPersistenceCodecPortV1(scheduler, () => REVISION);
  const sidecar = completeSidecar();
  const expected = encodeInkbookSidecarV1(sidecar, "phone");
  const work = createPersistenceEncodeWorkV1(
    sidecar,
    "phone",
    1_048_576,
    expected.byteLength,
  );
  const cancelled = port.submit(work);
  cancelled.cancel();

  await expect(cancelled.result).rejects.toMatchObject({ name: "AbortError" });
  const cold = port.submit(work);
  slices.flushAll();
  await expect(cold.result).resolves.toMatchObject({
    kind: "encoded-sidecar",
    encodedElementCount: sidecar.scene.elements.length,
    reusedElementCount: 0,
  });
  const warm = port.submit(work);
  slices.flushAll();
  await expect(warm.result).resolves.toMatchObject({
    kind: "encoded-sidecar",
    encodedElementCount: 0,
    reusedElementCount: sidecar.scene.elements.length,
  });
  const otherSidecar = {
    ...sidecar,
    noteIdentity: {
      ...sidecar.noteIdentity,
      vaultRelativeMarkdownPath: "Notes/Other.md",
    },
  };
  const otherBytes = encodeInkbookSidecarV1(otherSidecar, "phone");
  const other = port.submit(
    createPersistenceEncodeWorkV1(
      otherSidecar,
      "phone",
      1_048_576,
      otherBytes.byteLength,
    ),
  );
  slices.flushAll();
  await expect(other.result).resolves.toMatchObject({
    encodedElementCount: sidecar.scene.elements.length,
  });
  const originalAgain = port.submit(work);
  slices.flushAll();
  await expect(originalAgain.result).resolves.toMatchObject({
    encodedElementCount: 0,
    reusedElementCount: sidecar.scene.elements.length,
  });
  port.dispose();
  scheduler.dispose();
});
