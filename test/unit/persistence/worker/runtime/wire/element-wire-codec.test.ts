import { expect, it } from "vitest";

import { validateInkElementV1 } from "../../../../../../src/domain/schema/public";
import { unpackElementsSteps } from "../../../../../../src/persistence/worker/runtime/wire/element-wire-codec";
import { completeSerializationSteps } from "../../../../../../src/persistence/serialization/output/serialization-model-preparation";
import { decodeRuntimeRequestChunked } from "../../../../../../src/persistence/worker/runtime/wire/request-wire-decoding";
import { rectangle, snapshot } from "../fixtures";

it.each([0, -1, -2])(
  "preserves an illegal non-stroke buffer index %s for exact-key validation",
  (pointsBufferIndex) => {
    const record = { ...rectangle(), pointsBufferIndex };
    const [element] = completeSerializationSteps(
      unpackElementsSteps({ pointBuffers: [], records: [record] }),
    );

    expect(element).toEqual(record);
    expect(validateInkElementV1(element)).toMatchObject({
      ok: false,
      error: { code: "unknown-property", path: "$.pointsBufferIndex" },
    });
  },
);

it.each([
  "export-full-wire",
  "model-sync-full-wire",
  "export-incremental-wire",
  "model-sync-incremental-wire",
] as const)("keeps illegal non-stroke fields on %s requests", async (type) => {
  const record = { ...rectangle(), pointsBufferIndex: 0 };
  const packed = { pointBuffers: [], records: [record] };
  const decoded = await decodeRuntimeRequestChunked(
    {
      type,
      ...(type === "export-full-wire" || type === "model-sync-full-wire"
        ? { snapshot: { ...snapshot(), elements: packed } }
        : { changedElements: packed }),
    },
    { checkpoint: () => undefined, signal: new AbortController().signal },
  );
  const elements =
    decoded.type === "export-full" || decoded.type === "model-sync-full"
      ? decoded.snapshot.elements
      : decoded.type === "export-incremental" || decoded.type === "model-sync-incremental"
        ? decoded.changedElements
        : undefined;

  expect(elements).toEqual([record]);
  expect(validateInkElementV1(elements?.[0])).toMatchObject({
    ok: false,
    error: { code: "unknown-property", path: "$.pointsBufferIndex" },
  });
});
