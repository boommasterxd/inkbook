import { DocumentCapacity } from "../../../../src/domain/store/document-capacity";
import { UniformSpatialIndex } from "../../../../src/domain/spatial/index";
import { describe, expect, it, vi } from "vitest";

import { PreparedElementMutations } from "../../../../src/domain/store/prepared-element-mutations";
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
        capacity: new DocumentCapacity(),
        index: new UniformSpatialIndex<string>(),
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

  it("reads the mutation source only once while checking the version throughout preparation", async () => {
    const element = rectangle();
    const capacity = new DocumentCapacity();
    capacity.addInitial(createInitialRecord(element));
    const index = new UniformSpatialIndex<string>();
    index.insert(element.id, createInitialRecord(element).bounds);
    const readSource = vi.fn(() => ({
      capacity,
      index,
      bands: { content: [element.id], highlight: [] },
      geometryVersion: 0,
      mutationVersion: 0,
      paintVersion: 0,
      records: new Map([[element.id, createInitialRecord(element)]]),
      reverseConnections: new Map(),
    }));
    const readVersion = vi.fn(() => 0);
    const mutations = new PreparedElementMutations(readSource, readVersion, () => ({
      delta: null,
      status: "noop",
      transition: null,
    }));
    const prepared = await mutations.prepare(
      {
        bands: { content: [], highlight: [] },
        removeIds: [element.id],
      },
      scheduler,
    );
    expect(prepared.status).toBe("prepared");
    expect(readSource).toHaveBeenCalledOnce();
    expect(readVersion.mock.calls.length).toBeGreaterThan(3);
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
