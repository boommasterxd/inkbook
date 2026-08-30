import { describe, expect, it } from "vitest";

import type {
  BoxShapeElementV1,
  InkSnapshotV1,
  LineElementV1,
} from "../../../../src/domain/schema/public";
import { moveSelection } from "../../../../src/editor/selection/public";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import { parseInkbookDocument } from "../../../../src/persistence/serialization/public";
import { reportedRotatedTable } from "../../../fixtures/editor/reported-rotated-table";
import { emptySnapshot, operation, persistenceHarness, rectangle } from "./vault-session-fixtures";

describe("vault-backed connected selection moves", () => {
  it("persists propagated line geometry through move, undo, and redo", async () => {
    const [first, second, line] = connectedElements();
    const { content, factory, session } = persistenceHarness(snapshot([first, second, line]));
    await session.unlock(operation());
    const model = requireModel(factory);
    const history = new ActiveEditorHistory(model);
    const movedFirst = translateBox(first, 50, 30);
    const movedSecond = translateBox(second, 50, 30);

    expect(history.replace([first, second], [movedFirst, movedSecond])).toBe(true);
    expect(model.revision).toBe(8);
    expectLine(model, { end: { x: 350, y: 170 }, start: { x: 230, y: 170 } });

    expect(history.undo()).toBe(true);
    expectLine(model, { end: { x: 300, y: 140 }, start: { x: 180, y: 140 } });
    expect(history.redo()).toBe(true);
    expectLine(model, { end: { x: 350, y: 170 }, start: { x: 230, y: 170 } });

    await expect(
      session.lockLatest({ ...operation(), operationId: 2, workspaceToken: 2 }),
    ).resolves.toMatchObject({ revision: 10, status: "confirmed" });
    const persisted = parseInkbookDocument(content());
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) throw new Error("Expected a persisted connected document.");
    expect(persisted.value.snapshot.elements).toEqual([
      movedFirst,
      movedSecond,
      expect.objectContaining({
        end: { x: 350, y: 170 },
        endConnection: line.endConnection,
        id: line.id,
        start: { x: 230, y: 170 },
        startConnection: line.startConnection,
      }),
    ]);
  });

  it("persists the reported rotated table after a rounding-sensitive move", async () => {
    const table = reportedRotatedTable();
    const { content, factory, session } = persistenceHarness(snapshot([table]));
    await session.unlock(operation());
    const model = requireModel(factory);
    const history = new ActiveEditorHistory(model);
    const moved = moveSelection([table], { x: -713.255, y: -144.957 })[0];
    if (moved?.kind !== "table") throw new Error("Expected a moved table.");

    expect(history.replace([table], [moved])).toBe(true);
    expect(model.store.get(table.id)?.element).toEqual(moved);
    await expect(
      session.lockLatest({ ...operation(), operationId: 2, workspaceToken: 2 }),
    ).resolves.toMatchObject({ revision: 8, status: "confirmed" });

    const persisted = parseInkbookDocument(content());
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) throw new Error("Expected a persisted rotated table document.");
    expect(persisted.value.snapshot.elements).toEqual([moved]);
  });
});

function connectedElements(): [BoxShapeElementV1, BoxShapeElementV1, LineElementV1] {
  const first = rectangle();
  const second: BoxShapeElementV1 = {
    ...rectangle(),
    id: "00000000-0000-4000-8000-000000000002",
    pivot: { x: 340, y: 140 },
    x: 300,
  };
  const line: LineElementV1 = {
    bend: null,
    createdAt: 2,
    end: { x: 300, y: 140 },
    endConnection: { anchor: { kind: "box", position: "middle-left" }, targetId: second.id },
    endNode: "none",
    id: "00000000-0000-4000-8000-000000000003",
    kind: "line",
    pivot: { x: 240, y: 140 },
    rotation: 0,
    start: { x: 180, y: 140 },
    startConnection: { anchor: { kind: "box", position: "middle-right" }, targetId: first.id },
    startNode: "none",
    style: {
      outlineColor: { type: "theme-text" },
      outlineOpacity: 1,
      outlineStyle: "solid",
      outlineWidth: 4,
    },
  };
  return [first, second, line];
}

function expectLine(
  model: EditableDocumentModel,
  expected: Pick<LineElementV1, "end" | "start">,
): void {
  expect(model.store.get("00000000-0000-4000-8000-000000000003")?.element).toMatchObject(expected);
}

function requireModel(
  factory: ReturnType<typeof persistenceHarness>["factory"],
): EditableDocumentModel {
  const model = factory.getDocumentModel("session-1");
  if (model === undefined) throw new Error("Expected an editable document model.");
  return model;
}

function snapshot(elements: InkSnapshotV1["elements"]): InkSnapshotV1 {
  return { ...emptySnapshot(), elements };
}

function translateBox(element: BoxShapeElementV1, x: number, y: number): BoxShapeElementV1 {
  return {
    ...element,
    pivot: { x: element.pivot.x + x, y: element.pivot.y + y },
    x: element.x + x,
    y: element.y + y,
  };
}
