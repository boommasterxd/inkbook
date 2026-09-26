import { afterEach, describe, expect, it, vi } from "vitest";
import * as safeSvg from "../../../src/persistence/documents/safe-svg-validator";
import * as pressure from "../../../src/domain/geometry/pressure-union";
import { verifyExactWorkerContent } from "../../../src/persistence/saving/autosave/trusted-verification";
import { ChunkedSha256 } from "../../../src/persistence/serialization/chunked-output-sha256";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/document-codec";
import { DocumentWorkerRuntime } from "../../../src/persistence/worker/runtime/public";
import { createStandardPersistenceFixture } from "./fixtures";

const identity = {
  operationId: 1,
  purpose: "preflight" as const,
  sessionId: "base",
  workerEpoch: 1,
};
afterEach(() => vi.restoreAllMocks());

describe("confirmed persisted base verification work", () => {
  it("checks all 10k-stroke source bytes without rescanning SVG or rebuilding pressure geometry", async () => {
    const snapshot = createStandardPersistenceFixture(2);
    const serialized = serializeInkbookDocument(snapshot);
    if (!serialized.ok) throw new Error(serialized.error.code);
    const runtime = new DocumentWorkerRuntime({ sessionId: "base", workerEpoch: 1 });
    const execute = vi.spyOn(runtime, "execute");
    const scan = vi.spyOn(safeSvg, "validateSafeSvgSteps");
    const geometry = vi.spyOn(pressure, "iteratePressureUnion");
    const hash = vi.spyOn(ChunkedSha256.prototype, "update");
    const confirmedBase = {
      outputHash: serialized.value.hash,
      revision: 2,
      type: "confirmed" as const,
    };
    await expect(
      verifyExactWorkerContent(runtime, identity, serialized.value.svg, "editable", {
        confirmedBase,
      }),
    ).resolves.toEqual(confirmedBase);
    expect(hash.mock.calls.reduce((bytes, [chunk]) => bytes + chunk.byteLength, 0)).toBe(
      new TextEncoder().encode(serialized.value.svg).byteLength,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    expect(geometry).not.toHaveBeenCalled();
    // An appended byte must take the normal validation path, even with the same revision.
    await expect(
      verifyExactWorkerContent(runtime, identity, serialized.value.svg + " ", "editable", {
        confirmedBase,
      }),
    ).resolves.toMatchObject({ revision: 2, type: "confirmed" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(scan).toHaveBeenCalledTimes(1);
    runtime.terminate();
  });
});
