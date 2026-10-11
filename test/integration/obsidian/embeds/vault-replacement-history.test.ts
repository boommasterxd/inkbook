import { describe, expect, it, vi } from "vitest";

import type { ElementReplacementHistoryData } from "../../../../src/domain/store/public";
import { connectedLine } from "../../../unit/domain/store/fixtures";
import { emptySnapshot, operation, persistenceHarness, rectangle } from "./vault-session-fixtures";

describe("vault replacement history capture", () => {
  it.each(["synchronous", "prepared"] as const)(
    "captures committed canonical records after revision publication through %s replacement",
    async (mode) => {
      const target = rectangle();
      const line = connectedLine(target);
      const { factory, session } = persistenceHarness({
        ...emptySnapshot(),
        elements: [target, line],
      });
      await session.unlock(operation());
      const model = factory.getDocumentModel("session-1");
      if (model === undefined) throw new Error("Expected an editable document model.");
      const previousTarget = model.store.get(target.id)!.element;
      const previousLine = model.store.get(line.id)!.element;
      const replacement = {
        ...target,
        x: target.x + 100,
        pivot: { ...target.pivot, x: target.pivot.x + 100 },
      };
      let captured: ElementReplacementHistoryData | undefined;
      const capture = vi.fn((history: ElementReplacementHistoryData) => {
        expect(model.revision).toBe(8);
        expect(session.getSnapshot()).toMatchObject({ dirty: true, revision: 8 });
        captured = history;
      });
      const published = vi.fn();
      const unsubscribe = model.store.subscribe(published);
      try {
        if (mode === "synchronous") model.replaceElements([replacement], capture);
        else {
          const preparation = await model.prepareElementReplacement([replacement], {
            isCancelled: () => false,
          });
          if (preparation.token === null) throw new Error("Expected a prepared replacement.");
          expect(model.commitPreparedElementReplacement(preparation.token, capture)).toBe(
            "committed",
          );
        }
        expect(capture).toHaveBeenCalledOnce();
        expect(published).toHaveBeenCalledOnce();
        expect(captured?.previous).toEqual([previousTarget, previousLine]);
        expect(captured?.previous[0]).toBe(previousTarget);
        expect(captured?.previous[1]).toBe(previousLine);
        expect(captured?.replacements[0]).toBe(model.store.get(target.id)!.element);
        expect(captured?.replacements[1]).toBe(model.store.get(line.id)!.element);
        expect(captured?.replacements[0]).not.toBe(replacement);
        expect(captured?.payloadBytes).toBeGreaterThan(0);

        const noopCapture = vi.fn();
        const current = model.store.get(target.id)!.element as typeof target;
        if (mode === "synchronous") model.replaceElements([current], noopCapture);
        else {
          const noop = await model.prepareElementReplacement([current], {
            isCancelled: () => false,
          });
          expect(noop.status).toBe("noop");
          expect(noop.token).toBeNull();
        }
        expect(noopCapture).not.toHaveBeenCalled();
        expect(model.revision).toBe(8);
        expect(published).toHaveBeenCalledOnce();
      } finally {
        unsubscribe();
        session.dispose();
      }
    },
  );

  it("does not capture stale or cancelled prepared replacements", async () => {
    const target = rectangle();
    const { factory, session } = persistenceHarness({ ...emptySnapshot(), elements: [target] });
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1");
    if (model === undefined) throw new Error("Expected an editable document model.");
    const replacement = { ...target, style: { ...target.style, outlineWidth: 8 as const } };
    const capture = vi.fn();
    try {
      const cancelled = await model.prepareElementReplacement([replacement], {
        isCancelled: () => true,
      });
      expect(cancelled.status).toBe("cancelled");
      expect(cancelled.token).toBeNull();
      const pending = await model.prepareElementReplacement([replacement], {
        isCancelled: () => false,
      });
      if (pending.token === null) throw new Error("Expected a prepared replacement.");
      model.replaceElements([{ ...target, style: { ...target.style, outlineOpacity: 0.5 } }]);
      expect(model.commitPreparedElementReplacement(pending.token, capture)).toBe("cancelled");
      expect(capture).not.toHaveBeenCalled();
      expect(model.revision).toBe(8);
      expect(model.store.get(target.id)!.element.style).toMatchObject({
        outlineOpacity: 0.5,
        outlineWidth: 4,
      });
    } finally {
      session.dispose();
    }
  });
});
