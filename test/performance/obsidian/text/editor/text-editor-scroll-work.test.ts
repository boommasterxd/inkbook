// @vitest-environment happy-dom
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { TextEditorScroll } from "../../../../../src/obsidian/text/editor/text-editor-scroll";
import { prepareTextCaretReveal } from "../../../../../src/obsidian/embeds/active-editor/text-session-presentation";
import type {
  TextEditorClientRect,
  TextFieldEditorOptions,
} from "../../../../../src/obsidian/text/editor/text-field-editor-types";
import type { TextEditingSurface } from "../../../../../src/rendering/scene/text-editing-surface";
import { createNavigationHarness } from "../../../../fixtures/obsidian/navigation";

afterEach(() => vi.restoreAllMocks());

function fixture(flushInitial = true, ports: Partial<TextFieldEditorOptions> = {}) {
  const host = vi.fn((_rect: TextEditorClientRect) => true);
  const scroll = new TextEditorScroll({
    onScrollIntoView: host,
    prepareScrollIntoView: (rect) => () => host(rect),
    ...ports,
  });
  const source = "Line of source\n".repeat(2000);
  const state = EditorState.create({
    doc: source,
    selection: EditorSelection.cursor(source.length),
    extensions: scroll.extension,
  });
  const coords = vi.fn(() => ({ left: 10, right: 11, top: 2000, bottom: 2024 }));
  type Measurement = {
    read: (view: EditorView) => ReturnType<EditorView["coordsAtPos"]>;
    write: (rect: ReturnType<EditorView["coordsAtPos"]>, view: EditorView) => void;
  };
  const pending: Measurement[] = [];
  const measure = vi.fn((request: Measurement) => pending.push(request));
  const view = {
    state,
    dom: document.createElement("div"),
    contentHeight: 50000,
    hasFocus: true,
    coordsAtPos: coords,
    requestMeasure: measure,
  };
  const native = view as unknown as EditorView;
  scroll.attach(native);
  const notify = (geometryChanged = true, viewportChanged = false) =>
    scroll.update({
      view: native,
      state: view.state,
      transactions: [],
      geometryChanged,
      viewportChanged,
    } as unknown as ViewUpdate);
  const paint = () => {
    const request = pending.shift()!;
    request.write(request.read(native), native);
  };
  const handler = state.facet(EditorView.scrollHandler)[0]!;
  handler(native, state.selection.main, { x: "nearest", y: "nearest", xMargin: 5, yMargin: 5 });
  if (flushInitial) {
    paint();
    measure.mockClear();
  }
  return { scroll, view, coords, host, measure, pending, paint, notify };
}

it("tracks successive native height corrections without repeating reads or scrolling for unchanged height", () => {
  const state = fixture();
  expect(state.coords).toHaveBeenCalledOnce();
  expect(state.host).toHaveBeenCalledOnce();
  state.view.contentHeight += 2000;
  state.notify();
  expect(state.measure).toHaveBeenCalledOnce();
  expect(state.coords).toHaveBeenCalledOnce();
  state.paint();
  expect(state.coords).toHaveBeenCalledTimes(2);
  expect(state.host).toHaveBeenCalledTimes(2);
  for (let index = 0; index < 1000; index += 1) state.notify();
  expect(state.measure).toHaveBeenCalledOnce();
  expect(state.coords).toHaveBeenCalledTimes(2);
  state.notify(true, true);
  expect(state.host).toHaveBeenCalledTimes(2);
  state.coords.mockReturnValue({ left: 10, right: 11, top: 100, bottom: 124 });
  state.notify(true, true);
  expect(state.host).toHaveBeenCalledTimes(2);
  state.view.contentHeight += 2000;
  state.notify();
  state.paint();
  expect(state.host).toHaveBeenCalledTimes(3);
  state.coords.mockReturnValue({ left: 10, right: 11, top: 4000, bottom: 4024 });
  state.view.contentHeight += 2000;
  state.notify();
  state.paint();
  expect(state.host).toHaveBeenCalledTimes(4);
  expect(state.measure).toHaveBeenCalledTimes(3);
  state.scroll.dispose();
});

it("captures stable page bounds before height publication and extent writes can shift the input clip", () => {
  let clip = 0;
  const reveal = vi.fn();
  const map = vi.fn((rect: { top: number; bottom: number }) => ({
    minX: 0,
    maxX: 1,
    minY: rect.top + clip,
    maxY: rect.bottom + clip,
  }));
  const surface = { pageBoundsForClientRect: map } as unknown as TextEditingSurface;
  const state = fixture(false, {
    prepareScrollIntoView: (rect) =>
      prepareTextCaretReveal(surface, rect, reveal, () => {
        clip += 1000;
      }),
    onContentHeightChange: () => {
      clip += 2000;
    },
  });
  clip = 0;
  const request = state.pending.shift()!;
  const measured = request.read(state.view as unknown as EditorView);
  expect(reveal).not.toHaveBeenCalled();
  expect(map).toHaveBeenCalledOnce();
  state.view.contentHeight += 2000;
  request.write(measured, state.view as unknown as EditorView);
  expect(clip).toBe(3000);
  expect(reveal).toHaveBeenCalledExactlyOnceWith({ minX: 0, maxX: 1, minY: 2000, maxY: 2024 });
  expect(map).toHaveBeenCalledOnce();
  state.scroll.dispose();
});

it("never reads native coordinates from the scroll facet outside the public measurement read phase", () => {
  const state = fixture(false);
  let reading = false;
  state.coords.mockImplementation(() => {
    if (!reading) throw new Error("Reading the editor layout is not allowed during an update");
    return { left: 10, right: 11, top: 100, bottom: 124 };
  });
  expect(state.coords).not.toHaveBeenCalled();
  expect(state.host).not.toHaveBeenCalled();
  const request = state.pending.shift()!;
  reading = true;
  const measured = request.read(state.view as unknown as EditorView);
  reading = false;
  request.write(measured, state.view as unknown as EditorView);
  expect(state.coords).toHaveBeenCalledOnce();
  expect(state.host).toHaveBeenCalledOnce();
  state.scroll.dispose();
});

it("continues the retained page reveal only after a changed host height without rereading caret or source extent", () => {
  const extent = vi.fn(),
    reveal = vi.fn();
  const surface = {
    pageBoundsForClientRect: () => ({ minX: 0, maxX: 1, minY: 5300, maxY: 5324 }),
  } as unknown as TextEditingSurface;
  const state = fixture(false, {
    prepareScrollIntoView: (rect) => prepareTextCaretReveal(surface, rect, reveal, extent),
  });
  expect(state.scroll.hostLayoutChanged(1500)).toBeUndefined();
  state.paint();
  const resume = state.scroll.hostLayoutChanged(4883)!;
  for (let index = 0; index < 1000; index += 1)
    expect(state.scroll.hostLayoutChanged(4883)).toBeUndefined();
  expect(reveal).toHaveBeenCalledOnce();
  resume();
  expect(reveal).toHaveBeenCalledTimes(2);
  expect(extent).toHaveBeenCalledOnce();
  expect(state.coords).toHaveBeenCalledOnce();
  expect(state.measure).toHaveBeenCalledOnce();
  state.scroll.dispose();
});

it("finishes an actually clamped caret pan after the published host height and native scroll range reconcile", () => {
  const h = createNavigationHarness({
    activePageHeight: 6248.6,
    containerRect: { top: 100, left: 0, width: 1578, height: 1500.97 },
    ownerRect: { top: 0, left: 0, width: 1578, height: 1021 },
    ownerScrollHeight: 2214,
    ownerScrollTop: 0,
  });
  let scrollTop = 0;
  Object.defineProperty(h.owner, "scrollTop", {
    get: () => scrollTop,
    set: (requested: number) => {
      scrollTop = Math.max(0, Math.min(h.owner.scrollHeight - h.owner.clientHeight, requested));
      h.containerRect.top = 100 - scrollTop;
    },
  });
  const bounds = { minX: 397, maxX: 398, minY: 5300, maxY: 5324 };
  const state = fixture(false, {
    prepareScrollIntoView: () => () => {
      h.navigation.revealBounds(bounds);
      return true;
    },
  });
  state.scroll.hostLayoutChanged(1500.97);
  state.paint();
  h.frames.flushAll();
  expect(h.owner.scrollTop).toBe(1193);
  h.containerRect.height = 4883;
  const resumeAfterHostMeasure = state.scroll.hostLayoutChanged(4883)!;
  expect(h.frames.pending).toBe(0);
  Object.assign(h.owner, { scrollHeight: 5596 });
  resumeAfterHostMeasure();
  h.frames.flushAll();
  const bottom = h.containerRect.top + bounds.maxY * h.navigation.zoom;
  expect(bottom).toBeLessThanOrEqual(1005);
  expect(h.owner.scrollTop).toBeGreaterThan(3000);
  expect(state.coords).toHaveBeenCalledOnce();
  expect(state.measure).toHaveBeenCalledOnce();
  state.scroll.dispose();
  h.navigation.dispose();
});

it("retains host reconciliation across a commit or facet request for the same native source and selection", () => {
  const state = fixture();
  state.scroll.hostLayoutChanged(1500);
  const resume = state.scroll.hostLayoutChanged(4883)!;
  const native = state.view as unknown as EditorView;
  state.view.state.facet(EditorView.scrollHandler)[0]!(native, state.view.state.selection.main, {
    x: "nearest",
    y: "nearest",
    xMargin: 5,
    yMargin: 5,
  });
  state.paint();
  expect(state.host).toHaveBeenCalledTimes(2);
  resume();
  expect(state.host).toHaveBeenCalledTimes(3);
  expect(state.coords).toHaveBeenCalledTimes(2);
  state.scroll.dispose();
});

it("does not lose a height correction published between the native request read and write phases", () => {
  const state = fixture();
  state.scroll.update({
    view: state.view,
    state: state.view.state,
    transactions: [{ scrollIntoView: true }],
    geometryChanged: false,
  } as unknown as ViewUpdate);
  const request = state.pending.shift()!;
  const previous = request.read(state.view as unknown as EditorView);
  state.view.contentHeight += 2000;
  request.write(previous, state.view as unknown as EditorView);
  expect(state.host).toHaveBeenCalledTimes(2);
  state.notify();
  for (let index = 0; index < 1000; index += 1) state.notify();
  expect(state.pending).toHaveLength(1);
  expect(state.measure).toHaveBeenCalledTimes(2);
  state.coords.mockReturnValue({ left: 10, right: 11, top: 4000, bottom: 4024 });
  state.paint();
  expect(state.host).toHaveBeenCalledTimes(3);
  expect(state.coords).toHaveBeenCalledTimes(3);
  state.scroll.dispose();
});

it.each(["wheel", "pointerdown", "keydown", "selection", "source", "suspend", "dispose"] as const)(
  "cancels stale native caret work on %s and releases owned listeners",
  (action) => {
    const add = vi.spyOn(document, "addEventListener"),
      remove = vi.spyOn(document, "removeEventListener");
    const state = fixture();
    state.scroll.hostLayoutChanged(1500);
    const resume = state.scroll.hostLayoutChanged(4883)!;
    state.view.contentHeight += 2000;
    state.notify();
    if (action === "selection") {
      state.view.state = state.view.state.update({ selection: { anchor: 0 } }).state;
      state.notify(false);
    } else if (action === "source") {
      state.view.state = state.view.state.update({ changes: { from: 0, insert: "Next " } }).state;
      state.notify(false);
    } else if (action === "suspend") state.scroll.suspendGeometry(true);
    else if (action === "dispose") state.scroll.dispose();
    else document.dispatchEvent(new Event(action));
    state.paint();
    resume();
    expect(state.coords).toHaveBeenCalledOnce();
    expect(state.host).toHaveBeenCalledOnce();
    state.scroll.dispose();
    for (const name of ["pointerdown", "wheel", "keydown"]) {
      expect(add.mock.calls.filter(([type]) => type === name)).toHaveLength(1);
      expect(remove.mock.calls.filter(([type]) => type === name)).toHaveLength(1);
    }
  },
);
