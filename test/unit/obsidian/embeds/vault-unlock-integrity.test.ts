import * as canonical from "../../../../src/persistence/serialization/canonical-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ElementStore } from "../../../../src/domain/store/public";
import { verifyVaultUnlockIntegrity } from "../../../../src/obsidian/embeds/vault-unlock-integrity";
import {
  createTestStroke,
  createWorkerSnapshot,
} from "../../../fixtures/persistence/worker-snapshot";

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const first = createTestStroke();
  const snapshot = createWorkerSnapshot([
    first,
    { ...first, id: "00000000-0000-4000-8000-000000000002" },
  ]);
  const scheduler = { shouldYield: () => false, yieldControl: vi.fn(async () => undefined) };
  const builder = ElementStore.createBuilder(scheduler);
  await builder.appendOwnedRuntime(snapshot.elements);
  const store = await builder.finalize();
  if (store === null) throw new Error("Store creation failed.");
  return { scheduler, snapshot, store };
}

describe("owned unlock integrity", () => {
  it("proves exact ownership and order without canonicalizing points or materializing the store", async () => {
    const options = await fixture();
    const materialize = vi.spyOn(options.store, "materializeSnapshot");
    const canonicalize = vi.spyOn(canonical, "canonicalElement");
    await expect(verifyVaultUnlockIntegrity(options)).resolves.toBeUndefined();
    expect(materialize).not.toHaveBeenCalled();
    expect(canonicalize).not.toHaveBeenCalled();
    expect(options.store.instrumentation.snapshotMaterializations).toBe(0);
  });

  it.each(["identity", "order", "size"] as const)("rejects %s divergence", async (kind) => {
    const options = await fixture();
    if (kind === "identity") options.snapshot.elements[0] = { ...options.snapshot.elements[0]! };
    if (kind === "order") options.snapshot.elements.reverse();
    if (kind === "size") options.snapshot.elements.pop();
    await expect(verifyVaultUnlockIntegrity(options)).rejects.toThrow("diverged");
  });

  it("checks cancellation after cooperative adoption checkpoints", async () => {
    const options = await fixture();
    let cancelled = false;
    const yieldControl = vi.fn(async () => {
      cancelled = true;
    });
    await expect(
      verifyVaultUnlockIntegrity({
        ...options,
        scheduler: { shouldYield: () => true, yieldControl, isCancelled: () => cancelled },
      }),
    ).rejects.toThrow("cancelled");
    expect(yieldControl).toHaveBeenCalledOnce();
  });

  it("cancels before publishing even when no yield was necessary", async () => {
    const options = await fixture();
    const read = vi.spyOn(options.store, "get");
    const rank = vi.spyOn(options.store, "getRank");
    await expect(
      verifyVaultUnlockIntegrity({
        ...options,
        scheduler: { ...options.scheduler, isCancelled: () => true },
      }),
    ).rejects.toThrow("cancelled");
    expect(read).not.toHaveBeenCalled();
    expect(rank).not.toHaveBeenCalled();
  });
});
