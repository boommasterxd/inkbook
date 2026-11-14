// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";
import { ObsidianTextMathRenderer } from "../../../../../src/obsidian/text/math-renderer";
import {
  useActiveTextSessions,
  textSessionFontResources,
} from "../../../../fixtures/obsidian/active-text-session";
import { textElement } from "../../../../unit/domain/schema/fixtures";

const mount = useActiveTextSessions();

function input(state: ReturnType<typeof mount>): EditorView {
  const current = state.session.inputElement;
  if (!current) throw new Error("Expected an active text session input.");
  return EditorView.findFromDOM(current)!;
}

function press(state: ReturnType<typeof mount>, key: string, modifiers: KeyboardEventInit = {}) {
  input(state).contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...modifiers }),
  );
}

it("retains session input and focus when rapid cell replacements remove formulas and shrink committed layout", async () => {
  const source =
    "| A | B | C |\n| --- | --- | --- |\n| $\\sqrt{1}$ | $\\frac{1}{2}$ | $x$ |\n\nafter";
  const base = textElement();
  const state = mount({
    ...base,
    source,
    width: 300,
    pivot: { ...base.pivot, x: base.x + 150 },
    style: { ...base.style, fontFamily: "inter" },
  });
  state.prepare.mockRestore();
  Object.defineProperty(state.model, "fontResources", { value: textSessionFontResources() });
  const previousFonts = Object.getOwnPropertyDescriptor(document, "fonts");
  Object.defineProperty(document, "fonts", { configurable: true, value: { load: async () => [] } });
  vi.spyOn(ObsidianTextMathRenderer.prototype, "resolve").mockImplementation(async (latex) => {
    const height = latex === "x" ? 16 : 48;
    return { width: 20, height, ascent: height - 4, descent: 4, paths: [{ d: "M0 0L12 12Z" }] };
  });
  try {
    const initial = await state.session.reflow(state.element, new AbortController().signal);
    expect(initial.layout.math).toHaveLength(3);
    const prepared = await state.model.prepareElementReplacement([initial], {
      isCancelled: () => false,
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared" || prepared.token === null)
      throw new Error("Missing prepared table.");
    expect(state.model.commitPreparedElementReplacement(prepared.token)).toBe("committed");
    await expect(state.session.edit(base.id, source.length)).resolves.toBe(true);
    state.input().contentDOM.blur();
    await expect(state.session.edit(base.id, source.indexOf("$\\sqrt"))).resolves.toBe(true);
    // Replace the complete first formula, then navigate before any asynchronous layout settles.
    press(state, "a", { ctrlKey: true });
    input(state).dispatch(input(state).state.replaceSelection("LEFT42"));
    press(state, "Tab");
    press(state, "a", { ctrlKey: true });
    input(state).dispatch(input(state).state.replaceSelection("RIGHT42"));
    press(state, "Tab", { shiftKey: true });
    press(state, "End", { ctrlKey: true });
    input(state).dispatch(input(state).state.replaceSelection("!"));
    const retained = input(state);
    await expect(state.session.flush()).resolves.toBe(true);
    const saved = state.model.store.get(base.id)!.element as TextElementV2;
    expect(saved.source).toBe(
      source.replace("$\\sqrt{1}$", "LEFT42!").replace("$\\frac{1}{2}$", "RIGHT42"),
    );
    expect(saved.layout.math).toHaveLength(1);
    expect(saved.height).toBeLessThan(initial.height);
    expect(state.session.active).toBe(true);
    expect(state.session.activeId).toBe(base.id);
    expect(input(state)).toBe(retained);
    expect(retained.hasFocus).toBe(true);
    expect(retained.dom.isConnected).toBe(true);
    expect(state.renderer.beginTextEditing).toHaveBeenCalledOnce();
    expect(state.dispose).not.toHaveBeenCalled();
    expect(state.error).not.toHaveBeenCalled();
  } finally {
    state.session.dispose();
    if (previousFonts) Object.defineProperty(document, "fonts", previousFonts);
    else Reflect.deleteProperty(document, "fonts");
  }
});
