import { afterEach, describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../../src/domain/store/public";
import * as styleControls from "../../../../../src/obsidian/embeds/active-editor/controller-styles";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { ActiveEditorStyleSession } from "../../../../../src/obsidian/embeds/active-editor/style-session";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-model-port";
import { indexedStroke } from "../../../../fixtures/editor/stroke";
import { elementReplacementPorts } from "../../../../fixtures/obsidian/element-mutation-ports";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0)) dispose();
  vi.restoreAllMocks();
});

function cacheFixture(cache = true) {
  const first = indexedStroke(0);
  const second = { ...indexedStroke(1), style: { ...first.style, opacity: 0.5 } };
  const store = new ElementStore([first, second]);
  const sceneStore = new ElementSceneStore(store);
  let selection = new Set([first.id, second.id]);
  let identity: object = {};
  const model = { store, ...elementReplacementPorts(store) } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const originalSubscribe = store.subscribe.bind(store);
  const unsubscriptions: ReturnType<typeof vi.fn>[] = [];
  const subscriptions = vi.spyOn(store, "subscribe").mockImplementation((listener) => {
    const unsubscribe = vi.fn(originalSubscribe(listener));
    unsubscriptions.push(unsubscribe);
    return unsubscribe;
  });
  const changed = vi.fn();
  const styles = new ActiveEditorStyleSession({
    defaults: createBuiltInSettings().toolDefaults,
    history,
    store,
    sceneStore,
    selection: () => selection,
    ...(cache ? { selectionIdentity: () => identity } : {}),
    onStateChanged: changed,
    onSelectionGeometryChanged: changed,
  });
  const summary = vi.spyOn(styleControls, "createActiveEditorStyleControls");
  const reads = vi.spyOn(sceneStore, "get");
  cleanup.push(() => {
    styles.dispose();
    history.dispose();
    sceneStore.release();
  });
  return {
    changed,
    first,
    history,
    reads,
    second,
    store,
    styles,
    subscriptions,
    summary,
    unsubscriptions,
    get selection() {
      return selection;
    },
    setSelection: (ids: readonly string[]) => {
      selection = new Set(ids);
      identity = {};
    },
  };
}

function opacityControl(fixture: ReturnType<typeof cacheFixture>) {
  return fixture.styles.presentation("select").controls.find(({ id }) => id === "opacity");
}

describe("selected style presentation cache", () => {
  it("reuses canonical controls across tools without rereading or summarizing selected records", () => {
    const fixture = cacheFixture();
    const initial = fixture.styles.presentation("select");
    expect(initial.controls.find(({ id }) => id === "opacity")).toMatchObject({
      mixed: true,
      value: null,
    });
    expect(fixture.summary).toHaveBeenCalledOnce();
    expect(fixture.reads).toHaveBeenCalledTimes(2);
    for (const tool of ["draw", "rectangle", "select"] as const) {
      expect(fixture.styles.presentation(tool).controls).toBe(initial.controls);
    }
    expect(fixture.summary).toHaveBeenCalledOnce();
    expect(fixture.reads).toHaveBeenCalledTimes(2);
    fixture.styles.defaults.pen.color = { type: "rgba", value: "#EF4444FF" };
    fixture.styles.defaults.arrow.startNode = "diamond";
    fixture.styles.defaults.select.area = "rectangle";
    expect(fixture.styles.presentation("draw")).toMatchObject({
      icon: { outlineColor: { type: "rgba", value: "#EF4444FF" } },
      shapeIcon: { arrowStart: "diamond" },
      selectionArea: "rectangle",
    });
    expect(fixture.summary).toHaveBeenCalledOnce();
  });

  it("refreshes automatically for a new selection identity and explicit invalidation", () => {
    const fixture = cacheFixture();
    const initial = fixture.styles.presentation("select").controls;
    fixture.setSelection([fixture.second.id]);
    const selected = fixture.styles.presentation("select").controls;
    expect(selected).not.toBe(initial);
    expect(selected.find(({ id }) => id === "opacity")).toMatchObject({ mixed: false, value: 0.5 });
    expect(fixture.summary).toHaveBeenCalledTimes(2);
    expect(fixture.styles.presentation("select").controls).toBe(selected);
    fixture.styles.invalidateSelection();
    const invalidated = fixture.styles.presentation("select").controls;
    expect(invalidated).toEqual(selected);
    expect(invalidated).not.toBe(selected);
    expect(fixture.summary).toHaveBeenCalledTimes(3);
    fixture.setSelection([fixture.first.id, fixture.second.id]);
    expect(fixture.styles.presentation("select").controls).toEqual(initial);
    expect(fixture.styles.presentation("select").controls).not.toBe(initial);
    expect(fixture.summary).toHaveBeenCalledTimes(4);
  });

  it("invalidates once for each real edit, Undo, and Redo publication", () => {
    const fixture = cacheFixture();
    opacityControl(fixture);
    fixture.styles.apply("select", "opacity", 0.25);
    expect(fixture.history.commandCount).toBe(1);
    for (const direction of [undefined, "undo", "redo"] as const) {
      if (direction !== undefined) expect(fixture.history[direction]()).toBe(true);
      fixture.summary.mockClear();
      fixture.reads.mockClear();
      const first = opacityControl(fixture);
      expect(first).toMatchObject(
        direction === "undo" ? { mixed: true, value: null } : { mixed: false, value: 0.25 },
      );
      expect(opacityControl(fixture)).toBe(first);
      expect(fixture.summary).toHaveBeenCalledOnce();
      expect(fixture.reads).toHaveBeenCalledTimes(2);
    }
  });

  it("keeps the cache for a no-op without a store publication", () => {
    const fixture = cacheFixture();
    const initial = fixture.styles.presentation("select").controls;
    const element = fixture.store.get(fixture.first.id)!.element as InkElementV1;
    expect(fixture.store.replaceMany([element])).toBeNull();
    expect(fixture.styles.presentation("select").controls).toBe(initial);
    expect(fixture.summary).toHaveBeenCalledOnce();
  });

  it("invalidates after an unrelated element publishes without changing selected values", () => {
    const fixture = cacheFixture();
    const initial = fixture.styles.presentation("select").controls;
    fixture.store.create([indexedStroke(2)]);
    const refreshed = fixture.styles.presentation("select").controls;
    expect(refreshed).toEqual(initial);
    expect(refreshed).not.toBe(initial);
    expect(fixture.styles.presentation("select").controls).toBe(refreshed);
    expect(fixture.summary).toHaveBeenCalledTimes(2);
  });
});

describe("style presentation uncached defaults", () => {
  it.each(["empty", "missing"] as const)(
    "reads mutable tool defaults freshly for %s selection",
    (kind) => {
      const fixture = cacheFixture();
      fixture.setSelection(kind === "empty" ? [] : ["missing"]);
      const initial = fixture.styles.presentation("draw").controls;
      fixture.styles.defaults.pen.opacity = 0.25;
      fixture.styles.defaults.pen.color = { type: "rgba", value: "#EF4444FF" };
      const next = fixture.styles.presentation("draw");
      expect(next.controls).not.toBe(initial);
      expect(next.controls.find(({ id }) => id === "opacity")).toMatchObject({ value: 0.25 });
      expect(next.icon.outlineColor).toEqual({ type: "rgba", value: "#EF4444FF" });
      expect(fixture.summary).toHaveBeenCalledTimes(2);
    },
  );

  it("does not cache a standalone caller's mutable selection Set without a membership identity", () => {
    const fixture = cacheFixture(false);
    const initial = fixture.styles.presentation("select").controls;
    fixture.selection.delete(fixture.first.id);
    expect(opacityControl(fixture)).toMatchObject({ mixed: false, value: 0.5 });
    expect(fixture.styles.presentation("select").controls).not.toBe(initial);
    expect(fixture.summary).toHaveBeenCalledTimes(3);
    expect(fixture.subscriptions).not.toHaveBeenCalled();
  });
});

describe("style presentation cache lifecycle", () => {
  it("owns one subscription and releases it once, without accepting edits or repopulating after disposal", () => {
    const fixture = cacheFixture();
    const initial = fixture.styles.presentation("select").controls;
    expect(fixture.subscriptions).toHaveBeenCalledOnce();
    fixture.styles.dispose();
    fixture.styles.dispose();
    expect(fixture.unsubscriptions).toHaveLength(1);
    expect(fixture.unsubscriptions[0]).toHaveBeenCalledOnce();
    fixture.styles.apply("select", "opacity", 0.2);
    fixture.setSelection([]);
    fixture.styles.apply("draw", "opacity", 0.2);
    expect(fixture.history.commandCount).toBe(0);
    expect(fixture.changed).not.toHaveBeenCalled();
    expect(fixture.styles.defaults.pen.opacity).toBe(1);
    fixture.setSelection([fixture.first.id, fixture.second.id]);
    fixture.summary.mockClear();
    expect(fixture.styles.presentation("select").controls).not.toBe(initial);
    fixture.styles.presentation("select");
    expect(fixture.summary).toHaveBeenCalledTimes(2);
  });
});
