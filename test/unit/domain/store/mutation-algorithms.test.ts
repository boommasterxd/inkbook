import { describe, expect, it } from "vitest";

import { planElementMutation } from "../../../../src/domain/store/element-mutation";
import {
  assertOverflowCapacity,
  createInitialRecord,
} from "../../../../src/domain/store/record-factory";
import { MAX_OVERFLOW_ELEMENTS } from "../../../../src/domain/spatial/index";

import { rectangle } from "./fixtures";

const scheduler = {
  shouldYield: () => false,
  yieldControl: async () => undefined,
};

describe("element mutation algorithm bounds", () => {
  it("uses the prepared source rank map without searching band arrays", async () => {
    const element = rectangle();
    const content = [element.id];
    content.indexOf = () => {
      throw new Error("Mutation rank lookup must not scan a render band.");
    };
    const record = createInitialRecord(element);

    const plan = await planElementMutation(
      {
        bands: { content, highlight: [] },
        geometryVersion: 0,
        paintVersion: 0,
        ranks: new Map([[element.id, { band: "content", rank: 0 }]]),
        records: new Map([[element.id, record]]),
        reverseConnections: new Map(),
      },
      { bands: { content: [element.id], highlight: [] } },
      scheduler,
    );

    expect(plan).toBeNull();
  });

  it("counts a replaced-and-removed overflow record only once", () => {
    const oldRecord = overflowRecord("00000000-0000-4000-8000-000000000020");
    const firstReplacement = overflowRecord("00000000-0000-4000-8000-000000000021");
    const secondReplacement = overflowRecord("00000000-0000-4000-8000-000000000022");

    expect(() =>
      assertOverflowCapacity(
        MAX_OVERFLOW_ELEMENTS,
        [oldRecord],
        [firstReplacement, secondReplacement],
        [oldRecord],
      ),
    ).toThrow("The spatial-index overflow element limit was exceeded.");
  });
});

function overflowRecord(id: string) {
  return createInitialRecord({ ...rectangle(id), width: 100_000 });
}
