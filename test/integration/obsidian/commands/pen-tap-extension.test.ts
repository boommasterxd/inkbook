// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { createHtmlElement } from "../../../adapters/obsidian/dom";
import { mountPenTapEditor, penEvent } from "../../../fixtures/obsidian/pen-tap-extension";

const editors: ReturnType<typeof mountPenTapEditor>[] = [];

function mount(text?: string) {
  const editor = mountPenTapEditor(text);
  editors.push(editor);
  return editor;
}

afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

describe("pen insertion capture boundary", () => {
  it("falls back to CodeMirror's estimated position for the final empty line", () => {
    const { view, command, posAtCoords, setCursor } = mount("Text\n\n");
    posAtCoords.mockReturnValueOnce(null).mockReturnValue(6);
    const event = penEvent("pointerdown");
    view.contentDOM.dispatchEvent(event);
    view.contentDOM.dispatchEvent(penEvent("pointerup"));
    expect(event.defaultPrevented).toBe(true);
    expect(posAtCoords).toHaveBeenLastCalledWith({ x: 700, y: 400 }, false);
    expect(setCursor).toHaveBeenCalledWith({ line: 2, ch: 0 });
    expect(command).toHaveBeenCalledOnce();
  });

  it("clears trailing click suppression when another pointer begins", () => {
    const { view } = mount();
    view.contentDOM.dispatchEvent(penEvent("pointerdown"));
    view.contentDOM.dispatchEvent(penEvent("pointerup"));
    view.contentDOM.dispatchEvent(penEvent("pointerdown", { pointerType: "touch" }));
    const click = penEvent("click");
    view.contentDOM.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
  });

  it.each(["content", "scroll padding"])(
    "inserts on the final empty line from %s before host focus handlers run",
    (surface) => {
      const { view, command, setCursor } = mount();
      const target = surface === "content" ? view.contentDOM : view.scrollDOM;
      const hostFocus = vi.fn(() => view.contentDOM.focus());
      target.addEventListener("pointerdown", hostFocus);
      target.addEventListener("pointerup", hostFocus);
      target.addEventListener("click", hostFocus);
      for (const type of ["pointerdown", "pointerup", "click"]) {
        const event = penEvent(type);
        target.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(hostFocus).not.toHaveBeenCalled();
      expect(view.hasFocus).toBe(false);
      expect(setCursor).toHaveBeenCalledWith({ line: 1, ch: 0 });
      expect(command).toHaveBeenCalledOnce();
    },
  );

  it.each(["Text", "", "Text\n\n"])("resolves the last line of %j", (text) => {
    const { view, command, setCursor } = mount(text);
    view.scrollDOM.dispatchEvent(penEvent("pointerdown"));
    view.scrollDOM.dispatchEvent(penEvent("pointerup"));
    const accepted = text.endsWith("\n") || text === "";
    expect(command).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (accepted)
      expect(setCursor).toHaveBeenCalledWith({ line: text.split("\n").length - 1, ch: 0 });
  });
});

describe("pen insertion surface exclusions and lifecycle", () => {
  it.each(["mouse", "touch"])("preserves %s input without coordinate lookup", (pointerType) => {
    const { view, command, posAtCoords } = mount();
    const host = vi.fn();
    view.scrollDOM.addEventListener("pointerdown", host);
    const event = penEvent("pointerdown", { pointerType });
    view.scrollDOM.dispatchEvent(event);
    expect(host).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
    expect(posAtCoords).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it.each(["widget", "gutter", "scrollbar", "disabled", "unmapped"])(
    "leaves the %s boundary untouched",
    (boundary) => {
      const { view, command, enabled, posAtCoords } = mount();
      let target = view.scrollDOM;
      if (boundary === "widget" || boundary === "gutter") {
        target = createHtmlElement("div");
        if (boundary === "widget") target.className = "inkbook-root";
        (boundary === "widget" ? view.contentDOM : view.scrollDOM).append(target);
      }
      if (boundary === "disabled") enabled.mockReturnValue(false);
      if (boundary === "unmapped") posAtCoords.mockReturnValue(null);
      const event = penEvent("pointerdown", { clientX: boundary === "scrollbar" ? 790 : 700 });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
      view.scrollDOM.dispatchEvent(penEvent("pointerup"));
      expect(command).not.toHaveBeenCalled();
    },
  );

  it("cancels interrupted taps and ignores unrelated pointer releases", () => {
    const { view, command } = mount();
    view.scrollDOM.dispatchEvent(penEvent("pointerdown"));
    const unrelated = penEvent("pointerup", { pointerId: 8 });
    view.scrollDOM.dispatchEvent(unrelated);
    expect(unrelated.defaultPrevented).toBe(false);
    view.scrollDOM.dispatchEvent(penEvent("pointercancel", { pointerId: 8 }));
    view.scrollDOM.dispatchEvent(penEvent("pointercancel"));
    view.scrollDOM.dispatchEvent(penEvent("pointerup"));
    expect(command).not.toHaveBeenCalled();
    view.scrollDOM.dispatchEvent(penEvent("pointerdown"));
    view.scrollDOM.dispatchEvent(penEvent("pointerdown", { pointerType: "touch" }));
    view.scrollDOM.dispatchEvent(penEvent("pointerup"));
    expect(command).not.toHaveBeenCalled();
  });

  it("removes capture listeners and pending insertion on view destruction", () => {
    const { view, controller, command } = mount();
    const cancel = vi.spyOn(controller, "cancel");
    const surface = view.scrollDOM;
    surface.dispatchEvent(penEvent("pointerdown"));
    editors.pop()?.destroy();
    expect(cancel).toHaveBeenCalledWith(7);
    surface.dispatchEvent(penEvent("pointerdown"));
    surface.dispatchEvent(penEvent("pointerup"));
    surface.dispatchEvent(penEvent("click"));
    expect(command).not.toHaveBeenCalled();
  });
});
