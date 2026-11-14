// @vitest-environment happy-dom

import { EditorSelection, Transaction, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TextFieldEditor,
  type TextFieldEditorOptions,
} from "../../../../../src/obsidian/text/editor/text-field-editor";
import { ManualFrameScheduler } from "../../../../fixtures/obsidian/manual-frame-scheduler";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import {
  setTextLineBoundaries,
  textLineBoundariesSteps,
} from "../../../../../src/obsidian/text/editor/text-line-boundaries";
import { finishGeometrySteps } from "../../../../fixtures/domain/geometry-steps";

const editors: TextFieldEditor[] = [];

function mount(
  onScrollIntoView?: TextFieldEditorOptions["onScrollIntoView"],
  source = "One\nTwo",
  onContentHeightChange?: TextFieldEditorOptions["onContentHeightChange"],
  onScrollInterrupt?: TextFieldEditorOptions["onScrollInterrupt"],
) {
  const container = document.createElement("div");
  document.body.append(container);
  const editor = new TextFieldEditor({
    container,
    element: { ...textElement(), source },
    scheduler: workSchedulerFromFrames(new ManualFrameScheduler()),
    onChange: vi.fn(),
    onFinish: vi.fn(),
    ...(onScrollIntoView === undefined ? {} : { onScrollIntoView }),
    ...(onContentHeightChange === undefined ? {} : { onContentHeightChange }),
    ...(onScrollInterrupt === undefined ? {} : { onScrollInterrupt }),
  });
  editors.push(editor);
  return editor;
}

function pressBoundary(editor: TextFieldEditor, key: "Home" | "End", shift = false): KeyboardEvent {
  return pressKey(editor, key, { ctrlKey: true, shiftKey: shift });
}

function pressKey(
  editor: TextFieldEditor,
  key: string,
  options: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key,
    code: key,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  editor.view.contentDOM.dispatchEvent(event);
  return event;
}

function seedBoundaries(editor: TextFieldEditor): void {
  editor.view.dispatch({
    effects: setTextLineBoundaries.of(
      finishGeometrySteps(textLineBoundariesSteps(editor.view.state.doc)),
    ),
  });
}

function reveal(
  editor: TextFieldEditor,
  range: SelectionRange = EditorSelection.cursor(2),
): boolean {
  const handler = editor.view.state.facet(EditorView.scrollHandler)[0];
  if (!handler) throw new Error("The native scroll handler is missing.");
  return handler(editor.view, range, { x: "nearest", y: "nearest", xMargin: 5, yMargin: 5 });
}

function deferredReveal(editor: TextFieldEditor, action = () => reveal(editor)) {
  editor.view.dispatch({ selection: { anchor: 2 } });
  const coords = vi.spyOn(editor.view, "coordsAtPos").mockReturnValue(null);
  const measure = vi.spyOn(editor.view, "requestMeasure").mockImplementation(() => undefined);
  expect(action()).toBe(true);
  expect(measure.mock.calls.filter(([request]) => request !== undefined)).toHaveLength(1);
  const request = measure.mock.lastCall?.[0] as
    | {
        read: (view: EditorView) => ReturnType<EditorView["coordsAtPos"]>;
        write?: (rect: ReturnType<EditorView["coordsAtPos"]>, view: EditorView) => void;
      }
    | undefined;
  if (!request?.write) throw new Error("Missing deferred caret measurement.");
  return { coords, request, measure };
}

function measureReveal(editor: TextFieldEditor) {
  const measure = vi.spyOn(editor.view, "requestMeasure").mockImplementation(() => undefined);
  expect(reveal(editor, editor.view.state.selection.main)).toBe(true);
  const request = measure.mock.lastCall?.[0] as {
    read: (view: EditorView) => ReturnType<EditorView["coordsAtPos"]>;
    write: (rect: ReturnType<EditorView["coordsAtPos"]>, view: EditorView) => void;
  };
  request.write(request.read(editor.view), editor.view);
  return measure;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("silent native editor entry", () => {
  it("opens at the source end without reveal and reveals the first typed character once", () => {
    const onScroll = vi.fn(() => true);
    const editor = mount(onScroll);
    const measure = vi.spyOn(editor.view, "requestMeasure").mockImplementation(() => undefined);
    const rect = { left: 10, right: 11, top: 320, bottom: 340 };
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue(rect);
    editor.focusAt(editor.source.length, false);
    editor.focusSelectionPreserved();
    editor.requestCaretReveal();
    expect(editor.view.hasFocus).toBe(true);
    expect(editor.selectionStart).toBe(editor.source.length);
    expect(measure.mock.calls.filter(([request]) => request !== undefined)).toHaveLength(0);
    editor.view.dispatch({
      ...editor.view.state.replaceSelection("!"),
      scrollIntoView: true,
      userEvent: "input.type",
    });
    const request = measure.mock.lastCall?.[0];
    if (!request?.write) throw new Error("Missing first-input caret reveal.");
    request.write(request.read(editor.view), editor.view);
    expect(onScroll).toHaveBeenCalledExactlyOnceWith(rect);
    expect(editor.source).toBe("One\nTwo!");
    expect(editor.view.scrollDOM.scrollTop).toBe(0);
  });
});

describe("native document keyboard boundaries", () => {
  it("focuses a requested source end with host reveal while retaining later point-based positioning", () => {
    const source = "One\r\nTwo";
    const editor = mount(undefined, source);
    const dispatch = vi.spyOn(editor.view, "dispatch");
    const position = vi.spyOn(editor.view, "posAtCoords").mockReturnValue(1);
    editor.focusAt(source.length);
    expect(editor.selectionStart).toBe(editor.view.state.doc.length);
    expect(editor.view.hasFocus).toBe(true);
    expect(position).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenLastCalledWith({
      selection: { anchor: editor.view.state.doc.length },
      scrollIntoView: true,
    });
    editor.focusAt({ x: 10, y: 20 });
    expect(position).toHaveBeenCalledExactlyOnceWith({ x: 10, y: 20 });
    expect(editor.selectionStart).toBe(1);
    expect(editor.source).toBe("One\nTwo");
  });

  it("reveals keyboard document navigation through public measurement even without a native scroll-facet call", () => {
    const onScroll = vi.fn(() => true);
    const editor = mount(onScroll, "Text line\n".repeat(3_000));
    seedBoundaries(editor);
    const { coords, request } = deferredReveal(
      editor,
      () => pressBoundary(editor, "End").defaultPrevented,
    );
    expect(editor.view.state.selection.main.head).toBe(editor.source.length);
    expect(onScroll).not.toHaveBeenCalled();
    const rect = { left: 10, right: 11, top: 32_000, bottom: 32_020 };
    coords.mockReturnValue(rect);
    request.write?.(request.read(editor.view), editor.view);
    expect(onScroll).toHaveBeenCalledExactlyOnceWith(rect);
  });

  it("reaches complete source boundaries beyond the mounted DOM and requests host reveal", () => {
    const source = Array.from(
      { length: 3_000 },
      (_, index) => `Line ${String(index).padStart(4, "0")}`,
    ).join("\n");
    const editor = mount(undefined, source);
    seedBoundaries(editor);
    expect(editor.view.contentDOM.querySelectorAll(".cm-line").length).toBeLessThan(3_000);
    const dispatch = vi.spyOn(editor.view, "dispatch");
    expect(pressBoundary(editor, "End").defaultPrevented).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(source.length);
    expect(editor.view.contentDOM.textContent).toContain("Line 2999");
    const navigation = dispatch.mock.lastCall?.[0];
    expect(navigation).toBeInstanceOf(Transaction);
    if (!(navigation instanceof Transaction))
      throw new Error("Missing native command transaction.");
    expect(navigation.scrollIntoView).toBe(true);
    expect(navigation.isUserEvent("select")).toBe(true);
    expect(pressBoundary(editor, "Home").defaultPrevented).toBe(true);
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(editor.source).toBe(source);
    for (const boundary of editor.view.contentDOM.querySelectorAll(".inkbook-text-line-boundary")) {
      expect(boundary.textContent).toBe("");
      expect(boundary.getAttribute("aria-hidden")).toBe("true");
      expect(window.getComputedStyle(boundary).height).toBe("0px");
    }
  });

  it("extends selection to source boundaries while retaining the native anchor", () => {
    const editor = mount();
    editor.view.dispatch({ selection: { anchor: 2 } });
    pressBoundary(editor, "End", true);
    expect(editor.view.state.selection.main.anchor).toBe(2);
    expect(editor.view.state.selection.main.head).toBe(editor.source.length);
    pressBoundary(editor, "Home", true);
    expect(editor.view.state.selection.main.anchor).toBe(2);
    expect(editor.view.state.selection.main.head).toBe(0);
    expect(editor.source).toBe("One\nTwo");
  });
});

describe("native estimated height publication", () => {
  it("settles replaced and disposed native height requests even when CodeMirror never writes", () => {
    const editor = mount();
    const measure = vi.spyOn(editor.view, "requestMeasure").mockImplementation(() => undefined);
    const previous = vi.fn();
    const current = vi.fn();
    editor.measureContentHeight(previous);
    editor.measureContentHeight(current);
    expect(previous).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(current).not.toHaveBeenCalled();
    editor.dispose();
    expect(current).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(measure).toHaveBeenCalledTimes(2);
  });

  it("reads and publishes source height through the native measurement phases", () => {
    const editor = mount();
    editor.view.dom.style.height = "198789px";
    const measure = vi.spyOn(editor.view, "requestMeasure").mockImplementation(() => undefined);
    const styles = vi.spyOn(window, "getComputedStyle");
    const measured = vi.fn();
    editor.measureContentHeight(measured);
    expect(measured).not.toHaveBeenCalled();
    expect(styles.mock.calls.filter(([node]) => node === editor.view.dom)).toHaveLength(0);
    const request = measure.mock.lastCall?.[0] as {
      read: (view: EditorView) => number | undefined;
      write: (height: number | undefined, view: EditorView) => void;
    };
    editor.view.dom.style.height = "933.094px";
    const height = request.read(editor.view);
    expect(measured).not.toHaveBeenCalled();
    request.write(height, editor.view);
    expect(measured).toHaveBeenCalledExactlyOnceWith(933.094);
    expect(styles.mock.calls.filter(([node]) => node === editor.view.dom)).toHaveLength(1);
    editor.dispose();
    measure.mockClear();
    editor.measureContentHeight(measured);
    expect(measure).not.toHaveBeenCalled();
  });

  it("publishes changed public content height before host reveal and suppresses duplicate estimates", () => {
    const heights = vi.fn();
    const order: string[] = [];
    const editor = mount(
      () => {
        order.push("reveal");
        return true;
      },
      "One\nTwo",
      (height) => {
        heights(height);
        order.push("height");
      },
    );
    expect(heights).toHaveBeenCalledExactlyOnceWith(editor.contentHeight);
    editor.view.dispatch({ changes: { from: 0, insert: "Extra\n" } });
    expect(heights).toHaveBeenCalledTimes(2);
    expect(heights.mock.lastCall?.[0]).toBe(editor.contentHeight);
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({
      left: 0,
      right: 1,
      top: 10,
      bottom: 30,
    });
    measureReveal(editor);
    expect(order).toEqual(["height", "height", "reveal"]);
    expect(heights).toHaveBeenCalledTimes(2);
  });
});

describe("standard source editing commands", () => {
  it("deletes a native hardline boundary and reinserts Enter through the complete source state", async () => {
    const editor = mount();
    seedBoundaries(editor);
    editor.view.dispatch({ selection: { anchor: 4 } });
    expect(pressKey(editor, "Backspace").defaultPrevented).toBe(true);
    expect(editor.source).toBe("OneTwo");
    expect(editor.view.state.selection.main.head).toBe(3);
    expect(editor.view.contentDOM.querySelectorAll(".cm-line").length).toBe(1);
    await editor.flushChanges();
    expect(pressKey(editor, "Enter").defaultPrevented).toBe(true);
    expect(editor.source).toBe("One\nTwo");
    expect(editor.view.state.selection.main.head).toBe(4);
  });

  it("extends selection by a whole native grapheme and deletes it without splitting its Unicode source", () => {
    const editor = mount(undefined, "A👩‍💻B");
    seedBoundaries(editor);
    editor.view.dispatch({ selection: { anchor: 6 } });
    expect(pressKey(editor, "ArrowLeft", { shiftKey: true }).defaultPrevented).toBe(true);
    expect(editor.view.state.selection.main.anchor).toBe(6);
    expect(editor.view.state.selection.main.head).toBe(1);
    expect(pressKey(editor, "Backspace").defaultPrevented).toBe(true);
    expect(editor.source).toBe("AB");
  });
});

describe("host-owned native editor scrolling", () => {
  it("cancels host motion for a geometry owner and final disposal without restarting on resume", () => {
    const onScroll = vi.fn(() => true);
    const interrupt = vi.fn();
    const editor = mount(onScroll, "One\nTwo", undefined, interrupt);
    const { coords, request, measure } = deferredReveal(editor);
    coords.mockReturnValue({ left: 10, right: 11, top: 320, bottom: 340 });
    const rect = request.read(editor.view);
    editor.setGeometrySuspended(true);
    expect(interrupt).toHaveBeenCalledOnce();
    request.write?.(rect, editor.view);
    measure.mockClear();
    editor.setGeometrySuspended(false);
    editor.focusSelectionPreserved();
    editor.requestCaretReveal();
    expect(measure.mock.calls.filter(([pending]) => pending !== undefined)).toHaveLength(0);
    expect(onScroll).not.toHaveBeenCalled();
    editor.dispose();
    expect(interrupt).toHaveBeenCalledTimes(2);
    editor.dispose();
    expect(interrupt).toHaveBeenCalledTimes(2);
  });

  it("delegates caret geometry through the public scroll facet without editor updates or nested scrolling", () => {
    const onScroll = vi.fn(() => true);
    const editor = mount(onScroll);
    const rect = { left: 10, right: 11, top: 320, bottom: 340 };
    const coords = vi.spyOn(editor.view, "coordsAtPos").mockReturnValue(rect);
    editor.view.dispatch({ selection: { anchor: 2, head: 5 } });
    const dispatch = vi.spyOn(editor.view, "dispatch");
    measureReveal(editor);
    expect(coords).toHaveBeenCalledExactlyOnceWith(5, -1);
    expect(onScroll).toHaveBeenCalledExactlyOnceWith(rect);
    expect(dispatch).not.toHaveBeenCalled();
    expect(editor.view.scrollDOM.scrollTop).toBe(0);
  });

  it("claims configured deferred geometry and leaves unconfigured scrolling native", () => {
    const onScroll = vi.fn(() => false);
    const editor = mount(onScroll);
    const coords = vi.spyOn(editor.view, "coordsAtPos").mockReturnValue(null);
    measureReveal(editor);
    expect(onScroll).not.toHaveBeenCalled();
    coords.mockReturnValue({ left: 0, right: 1, top: 10, bottom: 30 });
    measureReveal(editor);
    expect(onScroll).toHaveBeenCalledOnce();
    const native = mount();
    expect(reveal(native)).toBe(false);
    editor.dispose();
    expect(reveal(editor)).toBe(false);
    expect(onScroll).toHaveBeenCalledOnce();
  });

  it("coalesces repeated viewport notifications into CodeMirror's pending native measurement and ignores them after disposal", () => {
    const frames = vi.spyOn(window, "requestAnimationFrame");
    const editor = mount(undefined, "Text line\n".repeat(3_000));
    const measure = vi.spyOn(editor.view, "requestMeasure");
    for (let index = 0; index < 20; index += 1) editor.requestViewportMeasure();
    expect(measure).toHaveBeenCalledTimes(20);
    expect(frames).toHaveBeenCalledOnce();
    editor.dispose();
    measure.mockClear();
    editor.requestViewportMeasure();
    expect(measure).not.toHaveBeenCalled();
  });
});

describe("deferred native caret reveal", () => {
  it.each(["wheel", "pointerdown"])(
    "keeps late geometry and focus passive after %s until typing resumes",
    (event) => {
      const onScroll = vi.fn(() => true);
      const interrupt = vi.fn();
      const editor = mount(onScroll, "One\nTwo", undefined, interrupt);
      editor.focusAt(editor.source.length, false);
      const { coords, request, measure } = deferredReveal(
        editor,
        () => pressBoundary(editor, "End").defaultPrevented,
      );
      const rect = { left: 10, right: 11, top: 320, bottom: 340 };
      coords.mockReturnValue(rect);
      const measured = request.read(editor.view);
      editor.view.dom.dispatchEvent(new Event(event, { bubbles: true }));
      expect(interrupt).toHaveBeenCalledOnce();
      request.write?.(measured, editor.view);
      measure.mockClear();
      editor.focusSelectionPreserved();
      editor.requestCaretReveal();
      editor.hostLayoutChanged(500)?.();
      editor.hostLayoutChanged(600)?.();
      expect(measure.mock.calls.filter(([pending]) => pending !== undefined)).toHaveLength(0);
      expect(onScroll).not.toHaveBeenCalled();
      editor.view.dispatch({
        ...editor.view.state.replaceSelection("!"),
        scrollIntoView: true,
        userEvent: "input.type",
      });
      const resumed = measure.mock.lastCall?.[0];
      if (!resumed?.write) throw new Error("Missing resumed typing reveal.");
      resumed.write(resumed.read(editor.view), editor.view);
      expect(onScroll).toHaveBeenCalledExactlyOnceWith(rect);
      expect(editor.source).toBe("One\nTwo!");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift", bubbles: true }));
      expect(interrupt).toHaveBeenCalledOnce();
      expect(editor.view.scrollDOM.scrollTop).toBe(0);
    },
  );

  it("coalesces keyboard and native facet requests into one coordinate read and host reveal", () => {
    const onScroll = vi.fn(() => true);
    const editor = mount(onScroll);
    const { coords, request, measure } = deferredReveal(
      editor,
      () => pressBoundary(editor, "End").defaultPrevented,
    );
    coords.mockReturnValue({ left: 10, right: 11, top: 320, bottom: 340 });
    expect(reveal(editor, editor.view.state.selection.main)).toBe(true);
    request.write?.({ left: 10, right: 11, top: 320, bottom: 340 }, editor.view);
    expect(onScroll).not.toHaveBeenCalled();
    expect(request.read(editor.view)).toBeNull();
    const latest = measure.mock.lastCall?.[0] as typeof request;
    latest.write?.(latest.read(editor.view), editor.view);
    expect(coords).toHaveBeenCalledOnce();
    expect(onScroll).toHaveBeenCalledOnce();
  });

  it("uses the opposite caret side within one native measurement", () => {
    const onScroll = vi.fn(() => true);
    const editor = mount(onScroll);
    const rect = { left: 10, right: 11, top: 320, bottom: 340 };
    vi.spyOn(editor.view, "coordsAtPos").mockImplementation((_position, side) =>
      side === -1 ? rect : null,
    );
    const measure = measureReveal(editor);
    expect(onScroll).toHaveBeenCalledExactlyOnceWith(rect);
    expect(measure).toHaveBeenCalledOnce();
  });

  it("reveals a newly drawn caret only in the public measurement write phase", () => {
    const onScroll = vi.fn(() => true);
    const editor = mount(onScroll);
    const { coords, request } = deferredReveal(editor);
    const rect = { left: 10, right: 11, top: 320, bottom: 340 };
    coords.mockReturnValue(rect);
    const measured = request.read(editor.view);
    expect(measured).toBe(rect);
    expect(onScroll).not.toHaveBeenCalled();
    request.write?.(measured, editor.view);
    expect(onScroll).toHaveBeenCalledExactlyOnceWith(rect);
  });

  it("rejects an old End reveal after Home changes selection and after disposal", () => {
    const onScroll = vi.fn(() => true);
    const editor = mount(onScroll);
    const { coords, request } = deferredReveal(editor);
    coords.mockReturnValue({ left: 10, right: 11, top: 320, bottom: 340 });
    const measured = request.read(editor.view);
    editor.view.dispatch({ selection: { anchor: 0 } });
    request.write?.(measured, editor.view);
    expect(request.read(editor.view)).toBeNull();
    editor.dispose();
    request.write?.(measured, editor.view);
    expect(onScroll).not.toHaveBeenCalled();
  });
});
