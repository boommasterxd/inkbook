import { vi } from "vitest";

import type { InkElementV1, TextElementV2 } from "../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../src/domain/settings/defaults";
import { ElementStore } from "../../../src/domain/store/public";
import { SelectionFrameSession } from "../../../src/editor/selection/public";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { PreparedElementHistory } from "../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { ActiveEditorStyleSession } from "../../../src/obsidian/embeds/active-editor/style-session";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-session/document-model-port";
import { layoutTextElement } from "../editor/text-style";
import { elementReplacementPorts } from "./element-mutation-ports";
import { immediateWorkScheduler } from "./immediate-work-scheduler";
import { createHandlePreviewRenderer } from "./selection-preview-renderer";
import type { StyleSliderPreviewOptions } from "../../../src/obsidian/embeds/active-editor/style-preview-presentation";

/** Real style, layout and history pipeline with an observed scene publication boundary. */
export function styleSliderFixture(
  selected: readonly InkElementV1[],
  unrelated: readonly InkElementV1[] = [],
  layout?: StyleSliderPreviewOptions["layout"],
) {
  const store = new ElementStore([...selected, ...unrelated]);
  const sceneStore = new ElementSceneStore(store);
  let selection: ReadonlySet<string> = new Set(selected.map(({ id }) => id));
  let revision = 0;
  let pending = false;
  let nextGate: Promise<void> | undefined;
  const reflow = vi.fn(async (element: TextElementV2, _signal: AbortSignal) => {
    const gate = nextGate;
    nextGate = undefined;
    await gate;
    return layoutTextElement(element);
  });
  const scheduler = immediateWorkScheduler();
  const model = {
    get revision() {
      return revision;
    },
    store,
    ...elementReplacementPorts(store, () => {
      revision += 1;
    }),
    beginInteractiveOperation: () => () => undefined,
  } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const commit = { arm: vi.fn(() => true), cancel: vi.fn() };
  const renderer = {
    ...createHandlePreviewRenderer(),
    beginPreviewCommit: vi.fn(() => commit),
  };
  const prepared = new PreparedElementHistory({
    reflowText: reflow,
    history,
    isAttached: () => true,
    model,
    motion: renderer,
    onPendingChanged: (value) => {
      pending = value;
    },
    workScheduler: scheduler,
  });
  const geometryChanged = vi.fn();
  const styles = new ActiveEditorStyleSession({
    defaults: createBuiltInSettings().toolDefaults,
    history,
    store,
    sceneStore,
    selection: () => selection,
    selectionFrames: new SelectionFrameSession(() => undefined),
    preparedHistory: prepared,
    onSelectionGeometryChanged: geometryChanged,
    onStateChanged: vi.fn(),
    isEnabled: () => !pending,
    preview: {
      renderer,
      pageToScreen: (point) => point,
      zoom: () => 1,
      workScheduler: scheduler,
      ...(layout === undefined ? {} : { layout }),
    },
  });
  return {
    styles,
    store,
    history,
    renderer,
    reflow,
    model,
    geometryChanged,
    commit,
    get pending() {
      return pending;
    },
    blockNextReflow() {
      let release = () => undefined as void;
      nextGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    changeSelection() {
      selection = new Set(selection);
      styles.invalidateSelection();
    },
    dispose(this: void) {
      styles.dispose();
      prepared.dispose();
      history.dispose();
      sceneStore.release();
    },
  };
}
