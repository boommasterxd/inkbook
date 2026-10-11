import { DocumentCapacity } from "../../../../src/domain/store/document-capacity";
import { UniformSpatialIndex } from "../../../../src/domain/spatial/index";
import { describe, expect, it, vi } from "vitest";

import { PreparedElementMutations } from "../../../../src/domain/store/prepared-element-mutations";
import { planElementMutation } from "../../../../src/domain/store/element-mutation";
import * as mutationOrder from "../../../../src/domain/store/mutation-order";
import * as mutationElements from "../../../../src/domain/store/mutation-elements";
import { ElementStore } from "../../../../src/domain/store/public";
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

describe("element mutation delta cancellation", () => {
  it.each(["insertion", "removal"] as const)(
    "cancels structural %s delta preparation at its shared checkpoint",
    async (kind) => {
      const element = rectangle();
      const added = rectangle("00000000-0000-4000-8000-000000000090");
      const store = new ElementStore([element]);
      const original = store.get(element.id);
      const published = vi.fn();
      store.subscribe(published);
      let deltaWork = false;
      let cancelled = false;
      const affectedIds = mutationOrder.mutationAffectedIds;
      const delta = vi.spyOn(mutationOrder, "mutationAffectedIds").mockImplementation(function* (
        ...args
      ) {
        deltaWork = true;
        yield* affectedIds(...args);
      });
      try {
        const prepared = await store.prepareElementMutation(
          kind === "insertion"
            ? { bands: { content: [element.id, added.id], highlight: [] }, elements: [added] }
            : { bands: { content: [], highlight: [] }, removeIds: [element.id] },
          {
            shouldYield: () => deltaWork,
            isCancelled: () => cancelled,
            yieldControl: async () => {
              cancelled = true;
            },
          },
        );
        expect(prepared).toEqual({ status: "cancelled", token: null });
        expect(delta).toHaveBeenCalledOnce();
        expect(store.get(element.id)).toBe(original);
        expect(store.get(added.id)).toBeUndefined();
        expect(published).not.toHaveBeenCalled();
      } finally {
        delta.mockRestore();
      }
    },
  );
});

describe("empty reverse connection preparation", () => {
  it("rejects an unknown removal ID after skipping unnecessary detachment work", async () => {
    const element = rectangle();
    const store = new ElementStore([element]);
    const original = store.get(element.id);
    await expect(
      store.prepareElementMutation(
        { bands: { content: [element.id], highlight: [] }, removeIds: ["missing"] },
        scheduler,
      ),
    ).rejects.toThrow("Unknown element ID: missing");
    expect(store.get(element.id)).toBe(original);
    expect(store.instrumentation.publishedDeltas).toBe(0);
  });

  it.each(["cancellation", "staleness"] as const)(
    "checks %s at the first real work after empty detachment collection",
    async (kind) => {
      const element = rectangle();
      const added = rectangle("00000000-0000-4000-8000-000000000090");
      const store = new ElementStore([element]);
      const original = store.get(element.id);
      let collected = false;
      let cancelled = false;
      const collect = mutationElements.collectDesiredElements;
      const collection = vi
        .spyOn(mutationElements, "collectDesiredElements")
        .mockImplementation(async (...args) => {
          const result = await collect(...args);
          collected = true;
          return result;
        });
      try {
        const prepared = await store.prepareElementMutation(
          { bands: { content: [], highlight: [] }, removeIds: [element.id] },
          {
            shouldYield: () => collected,
            isCancelled: () => cancelled,
            yieldControl: async () => {
              if (kind === "cancellation") cancelled = true;
              else store.create(added);
            },
          },
        );
        expect(prepared).toEqual({ status: "cancelled", token: null });
        expect(collection).toHaveBeenCalledOnce();
        expect(store.get(element.id)).toBe(original);
        expect(store.instrumentation.publishedDeltas).toBe(kind === "staleness" ? 1 : 0);
      } finally {
        collection.mockRestore();
      }
    },
  );
});

describe("structural capacity preparation cancellation", () => {
  it.each([
    ["insertion", "cancellation"],
    ["removal", "cancellation"],
    ["insertion", "staleness"],
    ["removal", "staleness"],
  ] as const)("rejects %s %s during its nonempty capacity phase", async (kind, interruption) => {
    const element = rectangle();
    const inserted = rectangle("00000000-0000-4000-8000-000000000090");
    const interleaved = rectangle("00000000-0000-4000-8000-000000000091");
    const store = new ElementStore([element]);
    const original = store.get(element.id);
    let cancelled = false;
    const prepare = Object.getOwnPropertyDescriptor(
      DocumentCapacity.prototype,
      "prepareTimeSliced",
    )!.value as DocumentCapacity["prepareTimeSliced"];
    const capacity = vi.spyOn(DocumentCapacity.prototype, "prepareTimeSliced");
    capacity.mockImplementation(function (this: DocumentCapacity, previous, next, work) {
      return prepare.call(this, previous, next, {
        ...work,
        shouldYield: () => true,
        yieldControl: async () => {
          if (interruption === "cancellation") cancelled = true;
          else store.create(interleaved);
        },
      });
    });
    try {
      const result = await store.prepareElementMutation(
        kind === "insertion"
          ? { bands: { content: [element.id, inserted.id], highlight: [] }, elements: [inserted] }
          : { bands: { content: [], highlight: [] }, removeIds: [element.id] },
        { ...scheduler, isCancelled: () => cancelled },
      );
      expect(result).toEqual({ status: "cancelled", token: null });
      expect(capacity).toHaveBeenCalledOnce();
      expect(store.get(element.id)).toBe(original);
      expect(store.get(inserted.id)).toBeUndefined();
      expect(store.instrumentation.publishedDeltas).toBe(interruption === "staleness" ? 1 : 0);
    } finally {
      capacity.mockRestore();
    }
  });
});

function overflowRecord(id: string) {
  return createInitialRecord({ ...rectangle(id), width: 100_000 });
}
