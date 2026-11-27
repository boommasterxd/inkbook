import { expect, it, vi } from "vitest";

import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { ActiveImageSession } from "../../../../../src/obsidian/embeds/active-editor/image-session";
import type { ImageImportRequest } from "../../../../../src/obsidian/embeds/active-scene/editor-chrome-openings";
import { rasterResource } from "../../../../fixtures/persistence/image-svg";
import { operation, persistenceHarness } from "../document-session/vault-session-fixtures";

it("imports all selected PDF pages as one reversible locked image batch", async () => {
  const { session } = persistenceHarness();
  try {
    await expect(session.unlock(operation())).resolves.toMatchObject({ status: "active" });
    const model = session.documentModel;
    if (model === undefined) throw new Error("Expected an active document model.");
    const history = new ActiveEditorHistory(model);
    const resource = rasterResource();
    const before = model.revision;
    let submission: ReturnType<ImageImportRequest["submit"]> | undefined;
    const select = vi.fn();
    const images = new ActiveImageSession({
      model,
      history,
      ownerWindow: { crypto: globalThis.crypto } as Window,
      isEnabled: () => true,
      finishText: () => Promise.resolve(true),
      selection: () => new Set(),
      select,
      visibleCenter: () => ({ x: 500, y: 1_500 }),
      onCommitted: vi.fn(),
      onFailed: vi.fn(),
      onImportImages: async (signal, _owner, request) => {
        submission = request.submit(
          { placement: "page-width-locked", resources: [resource, resource], source: "pdf" },
          signal,
        );
        await submission;
      },
    });

    try {
      images.import();
      await vi.waitFor(() => expect(submission).toBeDefined());
      await expect(submission).resolves.toBe("committed");
      const order = model.store.materializeBandOrder("image");
      const pages = order.map((id) => model.store.get(id)?.element);
      expect(pages).toMatchObject([
        { assetId: resource.id, kind: "image", locked: true, x: model.page.margin, y: 500 },
        { assetId: resource.id, kind: "image", locked: true, x: model.page.margin, y: 2_524.3 },
      ]);
      expect(model.imageResource?.(resource.id)).toEqual(resource);
      expect(select).toHaveBeenCalledWith(new Set());
      expect(model.revision).toBe(before + 1);
      expect(history.commandCount).toBe(1);

      await expect(history.undoAsync()).resolves.toBe(true);
      expect(model.store.materializeBandOrder("image")).toEqual([]);
      await expect(history.redoAsync()).resolves.toBe(true);
      expect(model.store.materializeBandOrder("image")).toEqual(order);
      expect(order.map((id) => model.store.get(id)?.element)).toEqual(pages);
      expect(model.imageResource?.(resource.id)).toEqual(resource);
    } finally {
      images.dispose();
      history.dispose();
    }
  } finally {
    session.dispose();
  }
});
