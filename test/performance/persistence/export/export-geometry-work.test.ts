import { afterEach, describe, expect, it, vi } from "vitest";
import * as bounds from "../../../../src/domain/geometry/bounds";
import * as paths from "../../../../src/domain/geometry/element-path";
import * as utf8 from "../../../../src/persistence/scheduling/utf8-byte-length";
import { chooseExportCut } from "../../../../src/domain/export/export-pagination";
import { prepareExportGeometry } from "../../../../src/persistence/export/export-geometry";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { createCapacityExportSvg } from "../../../fixtures/persistence/export-geometry";
import { inspectTrustedSvgOutput } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { ChunkedSha256 } from "../../../../src/persistence/serialization/chunked-output-sha256";
import { ChunkedInputHash } from "../../../../src/persistence/serialization/input/chunked-input-hash";
import {
  createWorkerBridgeHarness,
  createWorkerBridgeClient,
} from "../../../fixtures/persistence/worker-bridge";

afterEach(() => vi.restoreAllMocks());

describe("saved SVG export pagination work", () => {
  it("validates 10,000 stroke bounds once without contour preparation or repeated candidate work", async () => {
    const svg = createCapacityExportSvg();
    const trusted = await inspectTrustedSvgOutput(svg, undefined, {
      workScheduler: createTestWorkScheduler(),
    });
    const boundBuilds = vi.spyOn(bounds, "calculateElementBoundsSteps");
    const pathBuilds = vi.spyOn(paths, "buildElementPathParts");
    const inputWrites = vi.spyOn(TextEncoder.prototype, "encodeInto");
    const inputCounts = vi.spyOn(utf8, "utf8ByteLengthWithinLimit");
    const hashes = vi.spyOn(ChunkedSha256.prototype, "update");
    const scratchIterations = vi.spyOn(Uint16Array.prototype, Symbol.iterator);
    const metadataEncoding = vi.spyOn(TextEncoder.prototype, "encode");
    const digest = vi.spyOn(crypto.subtle, "digest");
    const copies = vi.spyOn(Uint8Array.prototype, "set");
    const releases = vi.spyOn(ChunkedInputHash.prototype, "release");
    const harness = createWorkerBridgeHarness();
    harness.clientEndpoint.cloneTransfers = true;
    harness.hostEndpoint.cloneTransfers = true;
    const runtime = createWorkerBridgeClient(harness.clientEndpoint);
    try {
      const prepared = await prepareExportGeometry(svg, {
        runtime,
        identity: { sessionId: "session-a", workerEpoch: 1, operationId: 1, purpose: "preflight" },
        workScheduler: createTestWorkScheduler(),
        safeStaticProof: trusted.safeStaticProof,
      });
      expect(prepared).toBeDefined();
      expect(boundBuilds).toHaveBeenCalledTimes(10_000);
      expect(pathBuilds).not.toHaveBeenCalled();
      // The in-process bridge also observes worker metadata hashing; isolate the sender's encoder.
      const sender = inputWrites.mock.contexts[0];
      const writes = inputWrites.mock.calls.filter(
        (_, index) => inputWrites.mock.contexts[index] === sender,
      );
      expect(writes.reduce((total, [text]) => total + text.length, 0)).toBe(svg.length);
      expect(writes.every(([text]) => text.length <= 16 * 1024)).toBe(true);
      expect(inputCounts).not.toHaveBeenCalled();
      expect(scratchIterations).not.toHaveBeenCalled();
      const metadataStart = svg.indexOf(">", svg.indexOf("<metadata")) + 1;
      const metadataEncoder =
        metadataEncoding.mock.contexts[
          metadataEncoding.mock.calls.findIndex(([text]) => text?.startsWith('{"format":"inkbook"'))
        ];
      expect(metadataEncoder).toBeDefined();
      const metadataWrites = metadataEncoding.mock.calls.filter(
        (_, index) => metadataEncoding.mock.contexts[index] === metadataEncoder,
      );
      expect(metadataWrites.reduce((total, [text]) => total + (text?.length ?? 0), 0)).toBe(
        svg.indexOf("</metadata>") - metadataStart,
      );
      const fullHashes = [...new Set(hashes.mock.contexts)].filter(
        (hash) => hash instanceof ChunkedSha256 && hash.totalBytes === trusted.totalBytes,
      );
      expect(fullHashes).toHaveLength(0);
      expect(digest).toHaveBeenCalledTimes(1);
      const owned = digest.mock.calls[0]?.[1] as Uint8Array;
      expect(owned.byteLength).toBe(trusted.totalBytes);
      expect(
        copies.mock.calls
          .filter((_, index) => copies.mock.contexts[index] === owned)
          .reduce((total, [source]) => total + source.length, 0),
      ).toBe(trusted.totalBytes);
      expect(
        [...new Set(hashes.mock.contexts)].filter(
          (hash) =>
            hash instanceof ChunkedSha256 &&
            hash.totalBytes === svg.indexOf("</metadata>") - metadataStart,
        ),
      ).toHaveLength(1);
      for (const hash of releases.mock.contexts) expect(hash).toHaveProperty("retainedBytes", 0);
      expect(harness.runtime.instrumentation).toMatchObject({ cacheElements: 0 });
      for (let page = 0; page < 100; page += 1) {
        const start = page * 900;
        const cut = chooseExportCut(prepared!, {
          start,
          limit: start + 900,
          minimum: 100,
          lookback: 500,
        });
        expect(cut).toBeGreaterThan(start);
        expect(cut).toBeLessThanOrEqual(start + 900);
      }
      expect(boundBuilds).toHaveBeenCalledTimes(10_000);
      expect(pathBuilds).not.toHaveBeenCalled();
    } finally {
      runtime.terminate();
      harness.runtime.terminate();
      harness.detach();
    }
  });
});
