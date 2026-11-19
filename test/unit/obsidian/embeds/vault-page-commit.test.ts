import { describe, expect, it, vi } from "vitest";
import { ElementStore } from "../../../../src/domain/store/public";
import { commitVaultPage } from "../../../../src/obsidian/embeds/document-session/vault-document-model";
import type { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import { rectangle, rectangleDocument, snapshot } from "../../persistence/worker/runtime/fixtures";

describe("vault page commits", () => {
  it("keeps page, revision and derived-height guards without snapshot materialization", () => {
    const store = new ElementStore([
      { ...rectangle(), y: 999_400, height: 10, pivot: { x: 150, y: 999_405 } },
    ]);
    const materialize = vi.spyOn(store, "materializeSnapshot");
    const commit = vi.fn();
    const recordCommit = vi.fn();
    const options = {
      autosave: { recordCommit } as unknown as AutosaveCoordinator,
      commit,
      page: snapshot().page,
      revision: 1,
      store,
    };
    expect(() => commitVaultPage({ ...options, revision: Number.MAX_SAFE_INTEGER })).toThrow(
      RangeError,
    );
    expect(() =>
      commitVaultPage({ ...options, page: { ...options.page, activeBufferLines: 0 } }),
    ).toThrow(RangeError);
    expect(() =>
      commitVaultPage({ ...options, page: { ...options.page, activeBufferLines: 8 } }),
    ).toThrow(RangeError);
    expect(commit).not.toHaveBeenCalled();
    expect(recordCommit).not.toHaveBeenCalled();
    expect(materialize).not.toHaveBeenCalled();
    commitVaultPage(options);
    expect(commit).toHaveBeenCalledOnce();
    expect(recordCommit).toHaveBeenCalledOnce();
  });

  it("accepts a page change after deleting enough bottom elements to leave stale index entries", () => {
    const source = rectangleDocument(600);
    const elements = source.elements.map((element, index) =>
      index < 300 ? { ...element, y: 999_400, height: 10, pivot: { x: 150, y: 999_405 } } : element,
    );
    const store = new ElementStore(elements);
    store.remove(elements.slice(0, 300).map(({ id }) => id));
    const indexedBottom = vi.spyOn(store, "getMaximumBottom");
    const recordCommit = vi.fn<AutosaveCoordinator["recordCommit"]>();
    const commit = vi.fn();
    const page = { ...source.page, activeBufferLines: 8 };

    commitVaultPage({
      autosave: { recordCommit } as unknown as AutosaveCoordinator,
      commit,
      page,
      revision: 1,
      store,
    });

    expect(indexedBottom).toHaveLastReturnedWith(999_411);
    expect(commit).toHaveBeenCalledExactlyOnceWith({ page, revision: 2 });
    expect(recordCommit).toHaveBeenCalledExactlyOnceWith({ page, modelRevision: 2 });
  });
});
