import { describe, expect, it, vi } from "vitest";
import { ElementStore } from "../../../../src/domain/store/public";
import { commitVaultPage } from "../../../../src/obsidian/embeds/vault-document-model";
import type { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import { rectangle, snapshot } from "../../persistence/worker/runtime/fixtures";

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
});
