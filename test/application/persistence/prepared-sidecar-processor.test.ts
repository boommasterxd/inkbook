import { describe, expect, it } from "vitest";

import { createPreparedCanonicalSidecarProcessorV1 } from "../../../src/application/persistence";
import { completeSidecar } from "./support";

describe("prepared canonical sidecar processor", () => {
  it("validates the envelope immediately and publishes no partial sidecar", () => {
    expect(() =>
      createPreparedCanonicalSidecarProcessorV1({
        ...completeSidecar(),
        format: "unsupported",
      }),
    ).toThrow(/format/u);

    const processor = createPreparedCanonicalSidecarProcessorV1(
      completeSidecar(),
      1,
    );
    expect(processor.complete()).toBeUndefined();
    while (!processor.processNext()) {
      expect(processor.complete()).toBeUndefined();
    }

    const prepared = processor.complete();
    expect(prepared?.elements).toHaveLength(
      completeSidecar().scene.elements.length,
    );
    expect(prepared?.sidecarWithoutElements.scene.elements).toEqual([]);
    expect(processor.complete()).toBe(prepared);
  });

  it("disposes the nested scene processor exactly once", () => {
    const processor =
      createPreparedCanonicalSidecarProcessorV1(completeSidecar());
    processor.dispose();
    processor.dispose();

    expect(() => processor.processNext()).toThrow(/disposed/u);
    expect(() => processor.complete()).toThrow(/disposed/u);
  });
});
