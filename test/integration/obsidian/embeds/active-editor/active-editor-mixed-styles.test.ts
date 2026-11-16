import { readElementStyle } from "../../../../fixtures/domain/element-style";
import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../../src/domain/settings/defaults";
import { createFreehandElement } from "../../../../../src/editor/tools/public";
import {
  createActiveEditorStyleControls,
  createSelectionStyleReplacement,
} from "../../../../../src/obsidian/embeds/active-editor/controller-styles";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { ActiveEditorStyleSession } from "../../../../../src/obsidian/embeds/active-editor/style-session";
import { validImageFixture } from "../../../../fixtures/persistence/images";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import {
  emptySnapshot,
  operation,
  persistenceHarness,
  rectangle,
} from "../document-session/vault-session-fixtures";

const defaults = createBuiltInSettings().toolDefaults;
const highlighter = createFreehandElement({
  defaults,
  identity: { id: "00000000-0000-4000-8000-000000000002", createdAt: 2 },
  samples: [10, 10, 0.5, 20, 20, 0.75],
  tool: "highlighter",
});
const selection = [highlighter, rectangle()];

it("styles handwriting over an explicitly selected locked image without changing its underlay", async () => {
  const { asset, element } = await validImageFixture();
  const image = { ...element, x: 0, y: 0, pivot: { x: 100, y: 50 }, locked: true };
  const harness = persistenceHarness({
    ...emptySnapshot(),
    version: 4,
    elements: [image, highlighter],
    imageResources: [asset],
  });
  await harness.session.unlock(operation());
  const model = harness.session.documentModel!;
  const history = new ActiveEditorHistory(model);
  const sceneStore = new ElementSceneStore(model.store);
  const styles = new ActiveEditorStyleSession({
    defaults,
    history,
    sceneStore,
    store: model.store,
    selection: () => new Set([image.id, highlighter.id]),
    onSelectionGeometryChanged: () => undefined,
    onStateChanged: () => undefined,
  });
  try {
    expect(styles.presentation("select").controls.map(({ id }) => id)).toEqual([
      "color",
      "stroke-width",
      "opacity",
    ]);
    styles.apply("select", "color", "#3B82F6FF");
    expect(readElementStyle(model.store.get(highlighter.id)?.element)).toMatchObject({
      color: { type: "rgba", value: "#3B82F6FF" },
    });
    expect(model.store.get(image.id)?.element).toEqual(image);
    expect(history.commandCount).toBe(1);
    expect(history.undo()).toBe(true);
    expect(model.store.get(image.id)?.element).toEqual(image);
    expect(history.redo()).toBe(true);
    await harness.session.lockLatest(operation());
    const saved = await parseInkbookDocumentForTest(harness.content());
    if (!saved.ok) throw new Error(saved.error.message);
    expect(saved.value.snapshot.elements).toEqual([
      image,
      {
        ...highlighter,
        style: { ...highlighter.style, color: { type: "rgba", value: "#3B82F6FF" } },
      },
    ]);
  } finally {
    styles.dispose();
    sceneStore.release();
    history.dispose();
    harness.session.dispose();
  }
});

describe("mixed selection Style controls", () => {
  it("offers only common paint controls with mixed values and resolves them after a change", () => {
    const controls = createActiveEditorStyleControls({ defaults, selection, tool: "select" });
    expect(controls.map(({ id }) => id)).toEqual(["color", "stroke-width", "opacity"]);
    for (const control of controls) expect(control).toMatchObject({ mixed: true, value: null });

    const changed = createSelectionStyleReplacement(selection, "stroke-width", "8");
    expect(changed).not.toBeNull();
    const updated = createActiveEditorStyleControls({
      defaults,
      selection: changed!.replacements,
      tool: "select",
    });
    expect(updated.find(({ id }) => id === "stroke-width")).toMatchObject({
      mixed: false,
      value: "8",
    });
    expect(updated.find(({ id }) => id === "color")).toMatchObject({ mixed: true, value: null });
  });

  it("commits one undoable common-color replacement and persists both style families", async () => {
    const { content, factory, session } = persistenceHarness({
      ...emptySnapshot(),
      elements: selection,
    });
    await session.unlock(operation());
    const model = factory.getDocumentModel("session-1");
    if (model === undefined) throw new Error("Expected an editable document model.");
    const history = new ActiveEditorHistory(model);
    const loadedSelection = selection.map(({ id }) => model.store.get(id)!.element as InkElementV1);
    const loadedStroke = loadedSelection[0];
    if (loadedStroke?.kind !== "stroke") throw new Error("Expected a loaded stroke.");
    expect(loadedStroke.points).toBeInstanceOf(Float64Array);
    const replacement = createSelectionStyleReplacement(loadedSelection, "color", "#3B82F6FF");
    if (replacement === null) throw new Error("Expected a shared color change.");

    expect(history.replace(replacement.previous, replacement.replacements)).toBe(true);
    expect(model.revision).toBe(8);
    expect(readElementStyle(model.store.get(highlighter.id)?.element)).toMatchObject({
      color: { type: "rgba", value: "#3B82F6FF" },
    });
    expect(readElementStyle(model.store.get(selection[1]!.id)?.element)).toMatchObject({
      outlineColor: { type: "rgba", value: "#3B82F6FF" },
      fillColor: null,
    });
    expect(
      createSelectionStyleReplacement(replacement.replacements, "color", "#3B82F6FF"),
    ).toBeNull();
    expect(history.undo()).toBe(true);
    for (const element of loadedSelection)
      expect(model.store.get(element.id)?.element).toEqual(element);
    expect(history.undo()).toBe(false);
    expect(history.redo()).toBe(true);
    for (const element of replacement.replacements) {
      expect(model.store.get(element.id)?.element).toEqual(element);
    }
    await expect(
      session.lockLatest({ ...operation(), operationId: 2, workspaceToken: 2 }),
    ).resolves.toMatchObject({ revision: 10, status: "confirmed" });
    const persisted = await parseInkbookDocumentForTest(content());
    if (!persisted.ok) throw new Error("Expected a persisted mixed-style document.");
    expect(persisted.value.snapshot.elements).toEqual(
      replacement.replacements.map((element) =>
        element.kind === "stroke" ? { ...element, points: Array.from(element.points) } : element,
      ),
    );
  });
});
