// @vitest-environment happy-dom
import { mountActiveTextSession } from "../../../../fixtures/obsidian/active-text-session";
import { afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
import {
  createActiveEditorModel,
  createHarness,
} from "../../../../fixtures/obsidian/active-controller";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { ActiveEditorMenuController } from "../../../../../src/obsidian/embeds/active-editor/controller-menu";
import { ActiveTextSession } from "../../../../../src/obsidian/embeds/active-editor/text-session";
import type { TextEditingCallbacks } from "../../../../../src/rendering/scene/text-editing-surface";
import { appendOwnedIframe } from "../../../../fixtures/obsidian/owned-iframe";
import {
  openFirstTextWithKeyboard,
  textActivationPointer,
} from "../../../../fixtures/obsidian/selected-text-activation";

beforeAll(installObsidianDomHelpers);
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function nativeTextController() {
  const configure = vi.spyOn(ActiveEditorMenuController.prototype, "configureToolbar");
  const toggle = vi.spyOn(ActiveEditorMenuController.prototype, "toggleToolbar");
  const edit = vi.spyOn(ActiveTextSession.prototype, "edit");
  const state = mountActiveTextSession();
  const { document: child } = appendOwnedIframe();
  child.body.append(state.container);
  const model = Object.defineProperties(
    createActiveEditorModel(state.model.store),
    Object.getOwnPropertyDescriptors(state.model),
  );
  const begin = state.renderer.beginTextEditing.bind(state.renderer);
  let callbacks: TextEditingCallbacks | undefined;
  const harness = createHarness(
    { model },
    {
      ...state.renderer,
      textDocument: child,
      beginTextEditing: (id, nextCallbacks) => {
        callbacks = nextCallbacks;
        const surface = begin(id, nextCallbacks);
        return surface ? { ...surface, ownerDocument: child } : undefined;
      },
    },
  );
  const pointer = (event: PointerEvent) => callbacks?.onPointerDown?.(event);
  child.addEventListener("pointerdown", pointer, true);
  const anchor = document.createElement("button");
  document.body.append(anchor);
  onTestFinished(() => {
    child.removeEventListener("pointerdown", pointer, true);
    harness.dispose();
    state.session.dispose();
  });
  await openFirstTextWithKeyboard(harness, state.container);
  await expect(edit.mock.results[0]!.value).resolves.toBe(true);
  const input = state.input();
  input.dispatch({ selection: { anchor: input.state.doc.length } });
  const openStyle = () => {
    input.contentDOM.blur();
    anchor.focus();
    harness.controller.handleToolbarAction("style", anchor);
    const menu: unknown = toggle.mock.instances[toggle.mock.instances.length - 1];
    if (!(menu instanceof ActiveEditorMenuController)) throw new Error("Missing Style controller.");
    expect(menu.isStyleOpen).toBe(true);
    return menu;
  };
  return {
    ...state,
    harness,
    child,
    input,
    anchor,
    openStyle,
    handlers: configure.mock.calls[0]![0].handlers,
  };
}

it("keeps Style open after committing formatting and immediately types at the retained child-editor caret", async () => {
  const state = await nativeTextController();
  const menu = state.openStyle();
  const content = state.input.contentDOM;
  state.handlers.onStylePreview?.("text-font-size", 40);
  expect(state.child.activeElement).not.toBe(content);
  expect(menu.isStyleOpen).toBe(true);
  state.handlers.onStyleChange("text-underline", true);
  expect(menu.isStyleOpen).toBe(true);
  expect(state.child.activeElement).toBe(content);
  expect(state.input.state.selection.main.head).toBe(5);
  state.input.dispatch(state.input.state.replaceSelection(" typed"));
  await vi.waitFor(() =>
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({
      source: "Hello typed",
    }),
  );
  expect(menu.isStyleOpen).toBe(true);
  expect(state.child.activeElement).toBe(content);
  expect(content.isConnected).toBe(true);
  await state.prepareExport();
  expect(state.model.store.get(state.element.id)?.element).toMatchObject({ source: "Hello typed" });
  expect(state.error).not.toHaveBeenCalled();
});

it.each(["mouse", "touch", "pen"] as const)(
  "closes only Style before native %s source-pointer handling",
  async (pointerType) => {
    const state = await nativeTextController();
    const menu = state.openStyle();
    const finish = vi.spyOn(ActiveTextSession.prototype, "finish");
    const nativePointer = vi.fn();
    state.input.contentDOM.addEventListener("pointerdown", nativePointer);
    const event = textActivationPointer("pointerdown", pointerType, { clientX: 150, clientY: 125 });
    state.input.contentDOM.dispatchEvent(event);
    expect(menu.isStyleOpen).toBe(false);
    expect(nativePointer).toHaveBeenCalledOnce();
    expect(finish).not.toHaveBeenCalled();
    expect(state.container.querySelector(".cm-editor")).not.toBeNull();
    expect(state.error).not.toHaveBeenCalled();
  },
);

it("consumes Escape in the owning child document only while Style is open and leaves other keys for native input", async () => {
  const state = await nativeTextController();
  const menu = state.openStyle();
  const finish = vi.spyOn(ActiveTextSession.prototype, "finish");
  const nativeKey = vi.fn();
  const content = state.input.contentDOM;
  content.addEventListener("keydown", nativeKey);
  const sibling = state.child.createElement("button");
  state.child.body.append(sibling);
  sibling.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  expect(menu.isStyleOpen).toBe(true);
  expect(finish).not.toHaveBeenCalled();
  const letter = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
  content.dispatchEvent(letter);
  expect(nativeKey).toHaveBeenCalledOnce();
  expect(letter.defaultPrevented).toBe(false);
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  content.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(menu.isStyleOpen).toBe(false);
  expect(nativeKey).toHaveBeenCalledOnce();
  expect(finish).not.toHaveBeenCalled();
  expect(state.child.activeElement).toBe(content);
  content.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(state.container.querySelector(".cm-editor")).toBeNull());
  expect(finish).toHaveBeenCalledOnce();
  expect(state.error).not.toHaveBeenCalled();
});
