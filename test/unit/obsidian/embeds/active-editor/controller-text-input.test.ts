// @vitest-environment happy-dom
import { ActiveEditorActions } from "../../../../../src/obsidian/embeds/active-editor/controller-actions";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { ActiveTextSession } from "../../../../../src/obsidian/embeds/active-editor/text-session";
import { ActiveEditorPointerController } from "../../../../../src/obsidian/embeds/active-editor/input/controller-pointer";
import { ActiveEditorMenuController } from "../../../../../src/obsidian/embeds/active-editor/controller-menu";
import {
  createHarness,
  createActiveEditorModel,
} from "../../../../fixtures/obsidian/active-controller";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { ElementStore } from "../../../../../src/domain/store/public";
import { textElement } from "../../../../fixtures/rendering/text";
import { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import {
  selectedTextActivation,
  lassoTextSelection,
  tapSelectedText,
  textActivationPointer,
} from "../../../../fixtures/obsidian/selected-text-activation";
import { rectangle } from "../../../domain/geometry/fixtures";

beforeAll(installObsidianDomHelpers);
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(["mouse", "pen", "touch"] as const)(
  "selects a %s target first and opens its next completed tap at the complete source end",
  (pointerType) => {
    const element = textElement();
    const state = selectedTextActivation([element]);
    tapSelectedText(state.controller, pointerType);
    expect(state.edit).not.toHaveBeenCalled();
    expect(state.renderer.setSelectedElements).toHaveBeenLastCalledWith(new Set([element.id]));
    state.controller.handlePointerDown(textActivationPointer("pointerdown", pointerType));
    expect(state.edit).not.toHaveBeenCalled();
    state.controller.handlePointerUp(textActivationPointer("pointerup", pointerType));
    expect(state.edit).toHaveBeenCalledExactlyOnceWith(element.id, element.source.length);
    state.input.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    expect(state.edit).toHaveBeenCalledOnce();
  },
);

function lowZoomTextActivation() {
  const element = textElement({
    x: 120,
    y: 100,
    width: 400,
    height: 422.344,
    pivot: { x: 320, y: 311.172 },
  });
  const state = selectedTextActivation([element]);
  state.controller.setZoom(0.145465);
  const point = { clientX: 37.48, clientY: 22.52 };
  tapSelectedText(state.controller, "touch", point);
  expect(state.renderer.setSelectedElements).toHaveBeenLastCalledWith(new Set([element.id]));
  return { ...state, element, point };
}

it("opens a low-zoom body tap outside the painted handle even inside its larger touch target", () => {
  const state = lowZoomTextActivation();
  expect(state.edit).not.toHaveBeenCalled();
  tapSelectedText(state.controller, "touch", state.point);
  expect(state.edit).toHaveBeenCalledExactlyOnceWith(state.element.id, state.element.source.length);
});

it("moves a low-zoom text body drag through the existing move pipeline instead of a nearby resize handle", () => {
  const state = lowZoomTextActivation();
  const move = vi.spyOn(PreparedElementHistory.prototype, "commitMove");
  const end = { ...state.point, clientX: state.point.clientX + 15 };
  state.controller.handlePointerDown(textActivationPointer("pointerdown", "touch", state.point));
  state.controller.handlePointerMove(textActivationPointer("pointermove", "touch", end));
  state.controller.handlePointerUp(textActivationPointer("pointerup", "touch", end));
  expect(move).toHaveBeenCalledOnce();
  expect(move.mock.calls[0]![1].x).toBeGreaterThan(0);
  expect(move.mock.calls[0]![1].y).toBe(0);
  expect(state.edit).not.toHaveBeenCalled();
  expect(state.model.store.get(state.element.id)?.element).toMatchObject({
    width: state.element.width,
    style: state.element.style,
  });
});

it("opens the first tap after area selection without requiring another selection press", async () => {
  const element = textElement();
  const state = selectedTextActivation([element]);
  lassoTextSelection(state.controller);
  await vi.waitFor(() =>
    expect(state.renderer.setSelectedElements).toHaveBeenLastCalledWith(new Set([element.id])),
  );
  expect(state.edit).not.toHaveBeenCalled();
  tapSelectedText(state.controller, "touch");
  expect(state.edit).toHaveBeenCalledExactlyOnceWith(element.id, element.source.length);
});

it("keeps a group selected when tapping one of its text fields", () => {
  const element = textElement();
  const other = textElement({
    id: "00000000-0000-4000-8000-000000000002",
    x: 300,
    pivot: { x: 400, y: 70 },
  });
  const state = selectedTextActivation([element, other]);
  state.input.focus();
  state.key("a", { ctrlKey: true });
  expect(state.renderer.setSelectedElements).toHaveBeenLastCalledWith(
    new Set([element.id, other.id]),
  );
  tapSelectedText(state.controller);
  expect(state.edit).not.toHaveBeenCalled();
  expect(state.renderer.setSelectedElements).toHaveBeenLastCalledWith(
    new Set([element.id, other.id]),
  );
});

it("leaves selected non-text elements in their existing selection gesture", () => {
  const shape = rectangle();
  const state = selectedTextActivation([shape]);
  state.input.focus();
  state.key("Home");
  tapSelectedText(state.controller, "mouse", { clientX: 50, clientY: 25 });
  expect(state.edit).not.toHaveBeenCalled();
  expect(state.renderer.setSelectedElements).toHaveBeenLastCalledWith(new Set([shape.id]));
});

it.each(["drag", "cancel", "shift", "control", "alt", "handle"] as const)(
  "preserves %s arbitration on an already selected text field",
  (gesture) => {
    const state = selectedTextActivation();
    tapSelectedText(state.controller);
    const options: PointerEventInit =
      gesture === "shift"
        ? { shiftKey: true }
        : gesture === "control"
          ? { ctrlKey: true }
          : gesture === "alt"
            ? { altKey: true }
            : gesture === "handle"
              ? { clientX: 210 }
              : {};
    state.controller.handlePointerDown(textActivationPointer("pointerdown", "mouse", options));
    if (gesture === "drag")
      state.controller.handlePointerMove(
        textActivationPointer("pointermove", "mouse", { clientX: 125 }),
      );
    const terminal = textActivationPointer(
      gesture === "cancel" ? "pointercancel" : "pointerup",
      "mouse",
      gesture === "drag" ? { clientX: 125 } : options,
    );
    if (gesture === "cancel") state.controller.handlePointerCancel(terminal);
    else state.controller.handlePointerUp(terminal);
    expect(state.edit).not.toHaveBeenCalled();
  },
);

it("finishes active text on canvas pointerdown without beginning a parallel gesture", () => {
  const harness = createHarness();
  try {
    vi.spyOn(ActiveTextSession.prototype, "active", "get").mockReturnValue(true);
    const finish = vi.spyOn(ActiveTextSession.prototype, "finish").mockResolvedValue(true);
    const pointer = vi.spyOn(ActiveEditorPointerController.prototype, "handlePointerDown");
    const event = new PointerEvent("pointerdown", {
      cancelable: true,
      pointerId: 1,
      pointerType: "mouse",
    });
    harness.controller.handlePointerDown(event);
    expect(event.defaultPrevented).toBe(true);
    expect(finish).toHaveBeenCalledOnce();
    expect(pointer).not.toHaveBeenCalled();
  } finally {
    harness.dispose();
  }
});

it("keeps Style available during text editing and runs a different tool only after text finishes", async () => {
  const harness = createHarness();
  try {
    let active = true;
    vi.spyOn(ActiveTextSession.prototype, "active", "get").mockImplementation(() => active);
    let resolveFinish!: (finished: boolean) => void;
    const finish = vi.spyOn(ActiveTextSession.prototype, "finish").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFinish = resolve;
        }),
    );
    const toggle = vi
      .spyOn(ActiveEditorMenuController.prototype, "toggleToolbar")
      .mockImplementation(() => undefined);
    harness.controller.handleToolbarAction("style");
    expect(toggle).toHaveBeenCalledExactlyOnceWith("style", undefined);
    expect(finish).not.toHaveBeenCalled();
    harness.controller.handleToolbarAction("text");
    expect(harness.controller.toolbarState().activeTool).toBe("draw");
    active = false;
    resolveFinish(true);
    await Promise.resolve();
    expect(harness.controller.toolbarState().activeTool).toBe("text");
  } finally {
    harness.dispose();
  }
});

it("returns focus to retained text input without closing Style, while slider input keeps its focus", () => {
  const configure = vi.spyOn(ActiveEditorMenuController.prototype, "configureToolbar");
  const sequence: string[] = [];
  vi.spyOn(ActiveTextSession.prototype, "active", "get").mockReturnValue(true);
  vi.spyOn(ActiveTextSession.prototype, "applyStyle").mockImplementation(() => {
    sequence.push("apply");
    return true;
  });
  vi.spyOn(ActiveEditorMenuController.prototype, "closeToolbar").mockImplementation(() => {
    sequence.push("close");
  });
  vi.spyOn(ActiveTextSession.prototype, "focusInput").mockImplementation(() => {
    sequence.push("focus");
  });
  const harness = createHarness();
  try {
    const handlers = configure.mock.calls[0]![0].handlers;
    handlers.onStylePreview?.("text-font-size", 40);
    expect(sequence).toEqual([]);
    const changes = [
      ["text-bold", true],
      ["text-italic", true],
      ["text-underline", true],
      ["text-strikethrough", true],
      ["text-font-family", "inter"],
      ["text-font-size", 40],
      ["text-color", "#123456"],
      ["text-opacity", 0.5],
      ["text-background-color", "#AA0000"],
      ["text-background-opacity", 0.6],
      ["text-alignment", "center"],
    ] as const;
    for (const [id, value] of changes) handlers.onStyleChange(id, value);
    expect(sequence).toEqual(changes.flatMap(() => ["apply", "focus"]));
  } finally {
    harness.dispose();
  }
});

it.each([true, false])(
  "keeps rejected source formatting scoped to the editor (active: %s)",
  (active) => {
    const configure = vi.spyOn(ActiveEditorMenuController.prototype, "configureToolbar");
    const element = textElement();
    const model = createActiveEditorModel(new ElementStore([element]));
    const harness = createHarness({ model });
    try {
      harness.controller.handleToolbarAction("select");
      harness.input.focus();
      harness.key("Home");
      vi.spyOn(ActiveTextSession.prototype, "active", "get").mockReturnValue(active);
      const apply = vi.spyOn(ActiveTextSession.prototype, "applyStyle").mockReturnValue(false);
      const replace = vi
        .spyOn(PreparedElementHistory.prototype, "commitStyle")
        .mockReturnValue(false);
      const close = vi.spyOn(ActiveEditorMenuController.prototype, "closeToolbar");
      const focus = vi.spyOn(ActiveTextSession.prototype, "focusInput");
      configure.mock.calls[0]![0].handlers.onStyleChange("text-font-size", 40);
      expect(apply).toHaveBeenCalledTimes(active ? 1 : 0);
      expect(replace).toHaveBeenCalledTimes(active ? 0 : 1);
      expect(close).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(model.store.get(element.id)?.element).toMatchObject({ style: element.style });
    } finally {
      harness.dispose();
    }
  },
);

it("rejects tool changes and external mutations when text finishing fails while keeping Copy embed available", async () => {
  const harness = createHarness();
  try {
    vi.spyOn(ActiveTextSession.prototype, "active", "get").mockReturnValue(true);
    vi.spyOn(ActiveTextSession.prototype, "finish").mockResolvedValue(false);
    const execute = vi
      .spyOn(ActiveEditorActions.prototype, "execute")
      .mockImplementation(() => undefined);
    harness.controller.executeAction("erase-all");
    harness.controller.handleToolbarAction("text");
    await Promise.resolve();
    expect(harness.controller.toolbarState().activeTool).toBe("draw");
    expect(execute).not.toHaveBeenCalled();
    harness.controller.executeAction("copy-embed");
    expect(execute).toHaveBeenCalledExactlyOnceWith("copy-embed");
  } finally {
    harness.dispose();
  }
});

it("opens text with Enter and preserves Shift+Enter for keyboard geometry editing", () => {
  const element = textElement();
  const model = createActiveEditorModel(new ElementStore([element]));
  const harness = createHarness({ model });
  const edit = vi.spyOn(ActiveTextSession.prototype, "edit").mockResolvedValue(true);
  try {
    harness.controller.handleToolbarAction("select");
    harness.input.focus();
    harness.key("Home");
    const geometry = harness.key("Enter", { shiftKey: true });
    expect(edit).not.toHaveBeenCalled();
    expect(geometry.defaultPrevented).toBe(true);
    expect(harness.input.textContent).toContain("Geometry editing");
    harness.key("Escape");
    harness.key("Enter");
    expect(edit).toHaveBeenCalledExactlyOnceWith(element.id);
  } finally {
    harness.dispose();
  }
});

it("discards a deferred external mutation after its presentation is disposed", async () => {
  const harness = createHarness();
  vi.spyOn(ActiveTextSession.prototype, "active", "get").mockReturnValue(true);
  let release!: (finished: boolean) => void;
  vi.spyOn(ActiveTextSession.prototype, "finish").mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const execute = vi
    .spyOn(ActiveEditorActions.prototype, "execute")
    .mockImplementation(() => undefined);
  harness.controller.executeAction("erase-all");
  harness.dispose();
  release(true);
  await Promise.resolve();
  expect(execute).not.toHaveBeenCalled();
});
