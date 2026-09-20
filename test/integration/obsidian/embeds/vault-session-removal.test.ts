import { describe, expect, it, vi } from "vitest";

import { ActiveDocumentHistory } from "../../../../src/obsidian/embeds/active-editor/document-history";
import { parseInkbookDocumentForTest } from "../../../fixtures/persistence/parse-document";
import { connectedLine, highlighter, IDS, rectangle } from "../../../unit/domain/store/fixtures";
import { emptySnapshot, operation, persistenceHarness } from "./vault-session-fixtures";

describe("vault-backed compact removal history", () => {
  it.each(["removed", "restored", "redone"] as const)(
    "persists %s connected ink without eager band materialization",
    async (outcome) => {
      const target = rectangle();
      const line = connectedLine(target);
      const survivor = rectangle(IDS.other, 600);
      const elements = [highlighter(), target, line, survivor];
      const { content, session } = persistenceHarness({ ...emptySnapshot(), elements });
      await session.unlock(operation());
      const context = session.editorContext;
      if (context === undefined) throw new Error("Expected an active document.");
      const { model, history } = context;
      const commands = new ActiveDocumentHistory({ model, history });
      const materialize = vi.spyOn(model.store, "materializeBandOrder");
      const unchanged = model.store.get(survivor.id);
      const published = vi.fn();
      const unsubscribe = model.store.subscribe(published);
      try {
        await expect(commands.remove([target.id])).resolves.toBe("applied");
        if (outcome !== "removed") await expect(history.undoAsync()).resolves.toBe(true);
        if (outcome === "redone") await expect(history.redoAsync()).resolves.toBe(true);
        expect(materialize).not.toHaveBeenCalled();
        expect(model.store.get(survivor.id)).toBe(unchanged);
        expect(published).toHaveBeenCalledTimes(
          outcome === "removed" ? 1 : outcome === "restored" ? 2 : 3,
        );
        const revision = model.revision;
        await expect(
          session.lockLatest({ ...operation(), operationId: 2, workspaceToken: 2 }),
        ).resolves.toMatchObject({ revision, status: "confirmed" });
        // Undo requires only its restored content band, never the unrelated highlight band.
        expect(materialize.mock.calls).toEqual(outcome === "removed" ? [] : [["content"]]);
        const persisted = await parseInkbookDocumentForTest(content());
        if (!persisted.ok) throw new Error("Expected a valid saved document.");
        expect(persisted.value.snapshot.elements).toEqual(
          outcome === "restored"
            ? elements
            : [elements[0], { ...line, startConnection: null }, survivor],
        );
      } finally {
        unsubscribe();
        commands.dispose();
        session.dispose();
      }
    },
  );
});
