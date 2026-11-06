// @vitest-environment happy-dom
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import { ElementStore } from "../../../../../../src/domain/store/public";
import { createBuiltInSettings } from "../../../../../../src/domain/settings/defaults";
import type { ToolDefaultsV1 } from "../../../../../../src/domain/settings/types";
import { SelectionFrameSession } from "../../../../../../src/editor/selection/public";
import { updateSessionToolDefaults } from "../../../../../../src/obsidian/embeds/active-editor/controller-styles";
import { createActiveEditorPreview } from "../../../../../../src/obsidian/embeds/active-editor/previews/controller-previews";
import { ElementSceneStore } from "../../../../../../src/obsidian/embeds/active-editor/scene-store";
import { createActiveEditorModel } from "../../../../../fixtures/obsidian/active-controller";
import {
  activeEditorPreparedHistory,
  activeEditorStoreHistory,
} from "../../../../../fixtures/obsidian/active-editor";
import {
  elementMutationPorts,
  elementReplacementPorts,
} from "../../../../../fixtures/obsidian/element-mutation-ports";
import { immediateWorkScheduler } from "../../../../../fixtures/obsidian/immediate-work-scheduler";
import { createSceneFixture, sceneDeltaEntries } from "../../../../../fixtures/rendering/scene";
import { rectangle } from "../../../../../unit/domain/store/fixtures";
import { holdPointer } from "../../../../../fixtures/obsidian/hold-to-shape";

afterEach(() => vi.useRealTimers());

function fixture() {
  const settings = createBuiltInSettings();
  const targets = [
    rectangle(undefined, 100, 100),
    rectangle("00000000-0000-4000-8000-000000000099", 500, 100),
  ];
  const store = new ElementStore(targets);
  const sceneStore = new ElementSceneStore(store);
  const model = {
    ...createActiveEditorModel(store),
    ...elementMutationPorts(store, () => undefined),
    ...elementReplacementPorts(store),
    get revision() {
      return store.mutationVersion;
    },
  };
  const scene = createSceneFixture(model.page, sceneStore);
  scene.scheduler.runAll();
  const release = store.subscribe((delta) =>
    scene.renderer.applyDelta({ affected: sceneDeltaEntries(delta) }),
  );
  const history = activeEditorStoreHistory(store);
  const preparedHistory = activeEditorPreparedHistory(model, history);
  const queries = vi.spyOn(sceneStore, "beginQuery");
  const previews: ReturnType<typeof createActiveEditorPreview>[] = [];
  const begin = (defaults: ToolDefaultsV1, tool: "line" | "arrow" | "draw", inverted = false) => {
    scene.scheduler.runAll();
    queries.mockClear();
    const preview = createActiveEditorPreview(
      {
        additive: false,
        kind: "tool-gesture",
        tool,
        pointer: holdPointer(102, 102),
      },
      {
        defaults,
        history,
        model,
        preparedHistory,
        sceneStore,
        renderer: scene.renderer,
        ownerWindow: {
          crypto: window.crypto,
          performance: { now: () => Date.now() },
          setTimeout: window.setTimeout.bind(window),
          clearTimeout: window.clearTimeout.bind(window),
        } as unknown as Window,
        workScheduler: immediateWorkScheduler(),
        pageToScreen: (point) => point,
        holdToShape: { enabled: true, holdDurationMs: 600, jitterTolerancePx: 4 },
        selection: () => new Set<string>(),
        selectionFrames: new SelectionFrameSession(),
        setSelection: () => undefined,
        snapping: settings.snapping,
        snappingInverted: () => inverted,
        zoom: () => 1,
      },
    );
    previews.push(preview);
    return preview;
  };
  const created = () => {
    const ids = store.materializeBandOrder("content");
    const id = ids[ids.length - 1]!;
    const element = store.get(id)!.element;
    if (element.kind !== "line" && element.kind !== "arrow")
      throw new Error("Expected native linear creation.");
    return element;
  };
  onTestFinished(() => {
    for (const preview of previews) preview.revert();
    preparedHistory.dispose();
    history.dispose();
    release();
    scene.renderer.destroy();
    sceneStore.release();
    queries.mockRestore();
  });
  return { settings, store, scene, history, queries, begin, created, targets };
}

describe("creation tool snapping Style gates", () => {
  it.each(["line", "arrow"] as const)(
    "snapshots the %s toggle and reuses native snapping for the next gesture or inversion",
    (tool) => {
      const test = fixture();
      const disabled = updateSessionToolDefaults(
        test.settings.toolDefaults,
        tool,
        "snapping-enabled",
        false,
      );
      const off = test.begin(disabled, tool);
      disabled[tool].snappingEnabled = true;
      off.update(holdPointer(502, 104));
      expect(off.commit()).toBe(true);
      expect(test.queries).not.toHaveBeenCalled();
      expect(test.created()).toMatchObject({
        start: { x: 102, y: 102 },
        end: { x: 502, y: 104 },
        startConnection: null,
        endConnection: null,
      });
      expect(test.history.undo()).toBe(true);

      const enabled = updateSessionToolDefaults(disabled, tool, "snapping-enabled", true);
      const on = test.begin(enabled, tool);
      on.update(holdPointer(502, 104));
      expect(on.commit()).toBe(true);
      expect(test.queries.mock.calls.length).toBeGreaterThan(0);
      expect(test.created()).toMatchObject({
        start: { x: 100, y: 100 },
        end: { x: 500, y: 100 },
        startConnection: { targetId: test.targets[0]!.id },
        endConnection: { targetId: test.targets[1]!.id },
      });
      expect(test.history.undo()).toBe(true);

      const inverted = test.begin(
        updateSessionToolDefaults(enabled, tool, "snapping-enabled", false),
        tool,
        true,
      );
      inverted.update(holdPointer(502, 104));
      expect(inverted.commit()).toBe(true);
      expect(test.queries.mock.calls.length).toBeGreaterThan(0);
      expect(test.created().endConnection?.targetId).toBe(test.targets[1]!.id);
    },
  );

  it("keeps pen-recognized connections independent of direct line and arrow toggles", () => {
    vi.useFakeTimers();
    const test = fixture();
    const line = updateSessionToolDefaults(
      test.settings.toolDefaults,
      "line",
      "snapping-enabled",
      false,
    );
    const defaults = updateSessionToolDefaults(line, "arrow", "snapping-enabled", false);
    const preview = test.begin(defaults, "draw");
    const points = [
      holdPointer(202, 102),
      holdPointer(302, 102),
      holdPointer(402, 102),
      holdPointer(502, 104),
    ];
    if (!("observeInputSamples" in preview)) throw new Error("Expected a draw preview.");
    preview.observeInputSamples(points);
    for (const point of points) preview.update(point);
    vi.advanceTimersByTime(600);
    expect(preview.commit()).toBe(true);
    expect(test.created()).toMatchObject({
      kind: "line",
      startConnection: { targetId: test.targets[0]!.id },
      endConnection: { targetId: test.targets[1]!.id },
    });
  });
});
