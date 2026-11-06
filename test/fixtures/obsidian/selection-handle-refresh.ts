import { onTestFinished, vi } from "vitest";

import type { InkElementV1 } from "../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../src/domain/settings/defaults";
import { ElementStore } from "../../../src/domain/store/public";
import { createDragElement } from "../../../src/editor/tools/public";
import { ActiveEditorHandleInteraction } from "../../../src/obsidian/embeds/active-editor/previews/handle-interaction";
import type { HandleInteractionRenderer } from "../../../src/obsidian/embeds/active-editor/previews/handle-presentation";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-session/document-model-port";
import { activeEditorPreparedHistory, activeEditorStoreHistory } from "./active-editor";
import { elementReplacementPorts } from "./element-mutation-ports";
import { ManualFrameScheduler } from "./manual-frame-scheduler";
import { createSelectionPreviewRenderer } from "./selection-preview-renderer";

export function selectionRefreshLinear(kind: "line" | "arrow" = "line") {
  return createDragElement({
    tool: kind,
    defaults: createBuiltInSettings().toolDefaults,
    identity: { id: "00000000-0000-4000-8000-000000000001", createdAt: 1 },
    start: { x: 100, y: 100 },
    end: { x: 120, y: 400 },
  });
}

export function selectionHandleRefreshFixture(
  elements: readonly InkElementV1[],
  selectedIds = elements.map(({ id }) => id),
) {
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  const selection = new Set(selectedIds);
  const scheduler = new ManualFrameScheduler();
  const renderer = {
    ...createSelectionPreviewRenderer(),
    clearElementPreviews: vi.fn(),
    flushPointerFeedbackFrame: vi.fn(),
    setElementPreviews: vi.fn(),
    setSelectionOverlayPath: vi.fn<HandleInteractionRenderer["setSelectionOverlayPath"]>(),
    setSnapMarkerPath: vi.fn(),
  };
  const model = {
    mutationAvailability: "available",
    ...elementReplacementPorts(store),
    get revision() {
      return store.mutationVersion;
    },
    setGestureActive: vi.fn(),
    store,
  } as unknown as EditableDocumentModel;
  const history = activeEditorStoreHistory(store);
  const interaction = new ActiveEditorHandleInteraction({
    frameScheduler: scheduler,
    history,
    model,
    pageToScreen: (point) => point,
    preparedHistory: activeEditorPreparedHistory(model, history),
    renderer,
    sceneStore,
    selection: () => selection,
    zoom: () => 1,
  });
  onTestFinished(() => {
    interaction.dispose();
    history.dispose();
    sceneStore.release();
    store.releasePreparedPressureGeometry();
  });
  return { interaction, store, sceneStore, selection, scheduler, renderer, history, model };
}
