import { afterEach, describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../../src/domain/store/public";
import { SelectionFrameSession } from "../../../../../src/editor/selection/public";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { ActiveEditorStyleSession } from "../../../../../src/obsidian/embeds/active-editor/style-session";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-model-port";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { elementMutationPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { createMaximumStroke } from "../../../../performance/domain/standard-domain-fixture";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
});

function gateScheduler() {
  let waiting = false;
  let gate = Promise.resolve();
  let resume = () => undefined as void;
  const scheduler = {
    ...immediateWorkScheduler(() => waiting),
    checkpoint: vi.fn(() =>
      waiting
        ? gate.then(() => {
            waiting = false;
          })
        : undefined,
    ),
  };
  return {
    scheduler,
    pause: () => {
      waiting = true;
      gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
    },
    resume: () => resume(),
  };
}

function sessionFixture(elements: readonly InkElementV1[]) {
  const store = new ElementStore(elements);
  const sceneStore = new ElementSceneStore(store);
  let selection: ReadonlySet<string> = new Set(elements.map(({ id }) => id));
  let pending = false;
  let enabled = true;
  let leased = false;
  let revision = 0;
  const gate = gateScheduler();
  const scheduler = gate.scheduler;
  const release = vi.fn(() => {
    leased = false;
  });
  const model = {
    get revision() {
      return revision;
    },
    store,
    ...elementMutationPorts(
      store,
      () => {
        revision += 1;
      },
      {
        shouldYield: () => scheduler.shouldYield(),
        yieldControl: () => scheduler.checkpoint() ?? Promise.resolve(),
      },
    ),
    beginInteractiveOperation: () => {
      leased = true;
      return release;
    },
  } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const framesChanged = vi.fn();
  const frames = new SelectionFrameSession(framesChanged);
  const geometryChanged = vi.fn(() => {
    expect(pending).toBe(false);
    expect(leased).toBe(false);
  });
  const stateChanged = vi.fn();
  const prepared = new PreparedElementHistory({
    history,
    isAttached: () => true,
    model,
    motion: { beginPreviewCommit: () => ({ arm: () => true, cancel: () => undefined }) },
    onPendingChanged: (value) => {
      pending = value;
    },
    workScheduler: scheduler,
  });
  const styles = new ActiveEditorStyleSession({
    defaults: createBuiltInSettings().toolDefaults,
    history,
    store,
    sceneStore,
    selection: () => selection,
    selectionFrames: frames,
    preparedHistory: prepared,
    onSelectionGeometryChanged: geometryChanged,
    onStateChanged: stateChanged,
    isEnabled: () => enabled && !pending,
  });
  cleanup.push(() => {
    prepared.dispose();
    history.dispose();
    sceneStore.release();
  });
  return {
    frames,
    framesChanged,
    geometryChanged,
    history,
    model,
    prepared,
    release,
    scheduler,
    stateChanged,
    store,
    styles,
    get pending() {
      return pending;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    invalidateSelection: () => {
      selection = new Set(selection);
    },
    pause: gate.pause,
    resume: gate.resume,
  };
}

function rotateFrame(
  fixture: ReturnType<typeof sessionFixture>,
  elements: readonly InkElementV1[],
) {
  const geometry = elements.map((element) => ({
    element,
    bounds: fixture.store.get(element.id)!.bounds,
  }));
  const frame = fixture.frames.current(geometry)!;
  fixture.frames
    .transition(frame, {
      center: { x: 200, y: 150 },
      degrees: 30,
      kind: "rotate",
    })!
    .apply();
  fixture.framesChanged.mockClear();
  return { geometry, frame: fixture.frames.current(geometry)! };
}

describe("prepared style session routing", () => {
  it.each([2, 1_001])(
    "applies %i selected records once per accepted event and honors the UI guard",
    async (count) => {
      const elements = Array.from({ length: count }, (_, index) => indexedStroke(index));
      const fixture = sessionFixture(elements);
      fixture.setEnabled(false);
      fixture.styles.apply("select", "opacity", 0.2);
      expect(fixture.history.commandCount).toBe(0);
      expect(fixture.pending).toBe(false);
      fixture.setEnabled(true);
      fixture.pause();

      fixture.styles.apply("select", "opacity", 0.5);
      expect(fixture.pending).toBe(true);
      fixture.styles.apply("select", "opacity", 0.3);
      fixture.resume();
      await vi.waitFor(() => expect(fixture.geometryChanged).toHaveBeenCalledOnce());
      expect(fixture.history.commandCount).toBe(1);
      expect(fixture.release).toHaveBeenCalledOnce();
      for (const element of elements) {
        expect(fixture.store.get(element.id)?.element.style).toMatchObject({ opacity: 0.5 });
      }
      fixture.styles.apply("select", "opacity", 0.3);
      await vi.waitFor(() => expect(fixture.geometryChanged).toHaveBeenCalledTimes(2));
      expect(fixture.history.commandCount).toBe(2);
      expect(fixture.pending).toBe(false);
      expect(fixture.release).toHaveBeenCalledTimes(2);
      expect(
        fixture.styles.presentation("select").controls.find(({ id }) => id === "opacity"),
      ).toMatchObject({ mixed: false, value: 0.3 });
      expect(fixture.framesChanged).not.toHaveBeenCalled();
      expect(fixture.stateChanged).not.toHaveBeenCalled();
    },
  );

  it("prepares width frame effects at the retained orientation and replays them exactly", async () => {
    const elements = [indexedStroke(0), indexedStroke(1)];
    const fixture = sessionFixture(elements);
    const { geometry, frame } = rotateFrame(fixture, elements);
    const current = vi.spyOn(fixture.frames, "currentTimeSliced");
    const rebase = vi.spyOn(fixture.frames, "rebaseTimeSliced");

    fixture.styles.apply("select", "stroke-width", "4");
    await vi.waitFor(() => expect(fixture.geometryChanged).toHaveBeenCalledOnce());
    expect(current).toHaveBeenCalledOnce();
    expect(rebase).toHaveBeenCalledOnce();
    expect(rebase.mock.calls[0]![0]).toBe(frame);
    const applied = fixture.frames.current(geometry)!;
    expect(applied.rotation).toBe(30);
    expect(fixture.framesChanged).toHaveBeenCalledOnce();
    expect(fixture.history.commandCount).toBe(1);
    for (const element of elements) {
      expect(fixture.store.get(element.id)?.element.style).toMatchObject({ width: 4 });
    }
    await expect(fixture.history.undoAsync()).resolves.toBe(true);
    expect(fixture.frames.current(geometry)).toBe(frame);
    for (const element of elements) {
      expect(fixture.store.get(element.id)?.element.style).toMatchObject({ width: 2 });
    }
    await expect(fixture.history.redoAsync()).resolves.toBe(true);
    expect(fixture.frames.current(geometry)).toBe(applied);
    expect(fixture.framesChanged).toHaveBeenCalledTimes(3);
    expect(
      fixture.styles.presentation("select").controls.find(({ id }) => id === "stroke-width"),
    ).toMatchObject({ mixed: false, value: "4" });
  });
});

describe("prepared style session cancellation", () => {
  it.each(["selection", "cancel"] as const)(
    "rejects %s invalidation during frame preparation",
    async (reason) => {
      const elements = [indexedStroke(0), indexedStroke(1)];
      const fixture = sessionFixture(elements);
      const { geometry, frame } = rotateFrame(fixture, elements);
      const original = fixture.frames.rebaseTimeSliced.bind(fixture.frames);
      const rebase = vi.spyOn(fixture.frames, "rebaseTimeSliced").mockImplementation((...args) => {
        fixture.pause();
        return original(...args);
      });
      const commit = vi.spyOn(fixture.model, "commitPreparedElementMutation");

      fixture.styles.apply("select", "stroke-width", "4");
      await vi.waitFor(() => expect(rebase).toHaveBeenCalledOnce());
      expect(fixture.pending).toBe(true);
      if (reason === "selection") fixture.invalidateSelection();
      else fixture.prepared.cancel();
      fixture.resume();
      await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
      expect(commit).not.toHaveBeenCalled();
      expect(fixture.history.commandCount).toBe(0);
      expect(fixture.geometryChanged).not.toHaveBeenCalled();
      expect(fixture.framesChanged).not.toHaveBeenCalled();
      expect(fixture.frames.current(geometry)).toBe(frame);
      expect(fixture.pending).toBe(false);
      for (const element of elements) {
        expect(fixture.store.get(element.id)?.element.style).toMatchObject({ width: 2 });
      }
    },
  );

  it("cancels maximum-stroke width preparation and retains owned samples through successful replay", async () => {
    const source = createMaximumStroke();
    const stroke = {
      ...source,
      points: source.points.map((value) => Math.round(value * 1_000) / 1_000),
      pivot: {
        x: Math.round(source.pivot.x * 1_000) / 1_000,
        y: Math.round(source.pivot.y * 1_000) / 1_000,
      },
    };
    const fixture = sessionFixture([stroke]);
    const points = fixture.store.get(stroke.id)!.element;
    if (points.kind !== "stroke") throw new TypeError("Expected stroke.");
    const ownedSamples = points.points;
    const original = fixture.model.prepareElementMutation.bind(fixture.model);
    const prepare = vi
      .spyOn(fixture.model, "prepareElementMutation")
      .mockImplementationOnce((...args) => {
        fixture.pause();
        return original(...args);
      });

    fixture.styles.apply("select", "stroke-width", "4");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(fixture.scheduler.checkpoint).toHaveBeenCalled();
    fixture.invalidateSelection();
    fixture.resume();
    await vi.waitFor(() => expect(fixture.release).toHaveBeenCalledOnce());
    expect(fixture.history.commandCount).toBe(0);
    fixture.styles.apply("select", "stroke-width", "4");
    await vi.waitFor(() => expect(fixture.geometryChanged).toHaveBeenCalledOnce());
    expect(fixture.history.commandCount).toBe(1);
    for (const replay of [undefined, "undoAsync", "redoAsync"] as const) {
      if (replay !== undefined) await expect(fixture.history[replay]()).resolves.toBe(true);
      const current = fixture.store.get(stroke.id)!.element;
      expect(current.kind === "stroke" && current.points).toBe(ownedSamples);
      expect(current.style).toMatchObject({ width: replay === "undoAsync" ? 8 : 4 });
    }
  });
});
