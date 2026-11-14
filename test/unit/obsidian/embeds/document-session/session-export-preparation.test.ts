import { expect, it, vi } from "vitest";
import { SessionExportPreparation } from "../../../../../src/obsidian/embeds/document-session/session-export-preparation";

it("cannot release a replacement presentation when an explicitly discarded preparation completes late", async () => {
  const preparation = new SessionExportPreparation();
  let finishOld!: () => void;
  preparation.register(
    () =>
      new Promise<void>((resolve) => {
        finishOld = resolve;
      }),
  );
  const oldRelease = vi.fn();
  preparation.deferRelease(oldRelease, vi.fn());
  preparation.clear();
  expect(oldRelease).toHaveBeenCalledOnce();
  let finishNew!: () => void;
  preparation.register(
    () =>
      new Promise<void>((resolve) => {
        finishNew = resolve;
      }),
  );
  const newRelease = vi.fn();
  preparation.deferRelease(newRelease, vi.fn());
  const current = preparation.prepare();
  finishOld();
  await Promise.resolve();
  expect(newRelease).not.toHaveBeenCalled();
  finishNew();
  await current;
  expect(newRelease).toHaveBeenCalledOnce();
  preparation.clear();
});
