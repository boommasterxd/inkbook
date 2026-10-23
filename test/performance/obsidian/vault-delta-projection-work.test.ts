import { expect, it, vi } from "vitest";

import { ElementStore, type StoreDelta } from "../../../src/domain/store/public";
import { recordVaultStoreDelta } from "../../../src/obsidian/embeds/document-session/vault-document-model";
import { VaultDocumentSessionMutations } from "../../../src/obsidian/embeds/document-session/vault-document-session-mutations";
import type { AutosaveCoordinator } from "../../../src/persistence/saving/autosave/public";
import {
  applyElementMutation,
  uninterruptedMutationScheduler,
} from "../../fixtures/domain/element-mutation";
import { createStandardRuntimeDomainFixture } from "../domain/standard-domain-fixture";

function observeDeltaProjection() {
  const work = { afterReads: 0, classifications: 0, entryVisits: 0, temporaryArrays: 0 };
  class ProjectionArray extends Array<StoreDelta["changes"][number]> {
    public constructor(length: number) {
      super(length);
      work.temporaryArrays += 1;
    }
  }
  return {
    work,
    capture(delta: StoreDelta): StoreDelta {
      const changes = delta.changes.map((change) => {
        const domains = [...change.domains];
        const classify = domains.some.bind(domains);
        domains.some = (...predicateArguments) => {
          work.classifications += 1;
          return classify(...predicateArguments);
        };
        return {
          ...change,
          domains,
          get after() {
            work.afterReads += 1;
            return change.after;
          },
        };
      });
      return {
        ...delta,
        changes: new Proxy(changes, {
          get(target, property, receiver) {
            if (property === "constructor") return { [Symbol.species]: ProjectionArray };
            if (typeof property === "string" && /^\d+$/u.test(property)) work.entryVisits += 1;
            return Reflect.get(target, property, receiver) as unknown;
          },
        }),
      };
    },
  };
}

it("projects 10K history and direct removal deltas once without intermediate array transforms", async () => {
  const fixture = createStandardRuntimeDomainFixture();
  const elements = fixture.elements.slice(0, fixture.strokeCount);
  const builder = ElementStore.createBuilder(uninterruptedMutationScheduler);
  await builder.appendOwnedRuntime(elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Expected hydrated store.");
  const removed = await applyElementMutation(store, {
    bands: { content: [], highlight: [] },
    removeIds: fixture.strokeIds,
  });
  const observer = observeDeltaProjection();
  const commit = store.commitPreparedElementMutation.bind(store);
  const commitSpy = vi.spyOn(store, "commitPreparedElementMutation").mockImplementation((token) => {
    const result = commit(token);
    return { ...result, delta: result.delta === null ? null : observer.capture(result.delta) };
  });
  const remove = store.remove.bind(store);
  const removeSpy = vi.spyOn(store, "remove").mockImplementation((ids) => {
    const delta = remove(ids);
    return delta === null ? null : observer.capture(delta);
  });
  const recordCommit = vi.fn<AutosaveCoordinator["recordCommit"]>();
  const autosave = { recordCommit } as unknown as AutosaveCoordinator;
  let revision = 1;
  const mutations = new VaultDocumentSessionMutations({
    autosave: () => autosave,
    commitState: vi.fn(),
    revision: () => revision,
    setRevision: (next) => {
      revision = next;
    },
    store: () => store,
  });
  try {
    for (const direction of ["reverse", "forward", "reverse"] as const) {
      const prepared = await store.prepareHistoryReplay(
        removed.transition[direction],
        uninterruptedMutationScheduler,
        removed.transition,
      );
      if (prepared.token === null) throw new Error("Expected prepared replay.");
      expect(mutations.commitPreparedElementMutation(prepared.token)).not.toBeNull();
    }
    mutations.removeElements(fixture.strokeIds);

    expect(observer.work).toEqual({
      afterReads: fixture.strokeCount * 4,
      classifications: fixture.strokeCount * 2,
      entryVisits: fixture.strokeCount * 4,
      temporaryArrays: 0,
    });
    expect(recordCommit).toHaveBeenCalledTimes(4);
    expect(
      recordCommit.mock.calls.map(([delta]) => [
        delta.modelRevision,
        delta.changedElements?.length,
        delta.changedElementDerivations?.length,
        delta.removedIds?.length,
      ]),
    ).toEqual([
      [2, 10_000, 10_000, 0],
      [3, 0, 0, 10_000],
      [4, 10_000, 10_000, 0],
      [5, 0, 0, 10_000],
    ]);
    expect(recordCommit.mock.calls.every(([delta]) => delta.dirtyBands?.includes("content"))).toBe(
      true,
    );
    expect(store.size).toBe(0);
  } finally {
    commitSpy.mockRestore();
    removeSpy.mockRestore();
  }
});

it("skips delta projection when autosave is unavailable", () => {
  const delta = {
    get changes(): StoreDelta["changes"] {
      throw new Error("Unavailable autosave must not inspect the delta.");
    },
    dirtyBands: { content: false, highlight: false },
    geometryVersion: 0,
    paintVersion: 0,
  };
  expect(() => recordVaultStoreDelta({ autosave: undefined, delta, revision: 1 })).not.toThrow();
});
