// @vitest-environment happy-dom
// Register the isolated text measurement adapter before composing the real controller.
import { useActiveTextSessions } from "../../../../fixtures/obsidian/active-text-session";
import { beforeAll, expect, it, onTestFinished, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { ActiveTextSession } from "../../../../../src/obsidian/embeds/active-editor/text-session";
import { TextFieldEditor } from "../../../../../src/obsidian/text/editor/text-field-editor";
import {
  createTextEditingSurface,
  type TextEditingCallbacks,
} from "../../../../../src/rendering/scene/text-editing-surface";
import { MountedTextPresentation } from "../../../../../src/rendering/scene/content/mounted-text";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import {
  createActiveEditorModel,
  createHarness,
} from "../../../../fixtures/obsidian/active-controller";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { appendOwnedIframe } from "../../../../fixtures/obsidian/owned-iframe";
import { textElement } from "../../../../fixtures/rendering/text";
import {
  lassoTextSelection,
  tapSelectedText,
  textActivationPointer,
} from "../../../../fixtures/obsidian/selected-text-activation";

beforeAll(installObsidianDomHelpers);
const mount = useActiveTextSessions();

function controllerSource() {
  const state = mount(textElement());
  const { frame, document: child } = appendOwnedIframe();
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(50, 70, 800, 600));
  const presentation = new MountedTextPresentation(child, state.element, createInstrumentation());
  const svg = child.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.append(presentation.group);
  child.body.append(svg);
  const begin = vi.fn((_id: string, callbacks: TextEditingCallbacks = {}) =>
    createTextEditingSurface(presentation, state.element, callbacks, () => {}),
  );
  const model = Object.defineProperties(
    createActiveEditorModel(state.model.store),
    Object.getOwnPropertyDescriptors(state.model),
  );
  const harness = createHarness(
    { model },
    { ...state.renderer, textDocument: child, beginTextEditing: begin },
  );
  harness.controller.handleToolbarAction("select");
  onTestFinished(harness.dispose);
  const inputDocument = () =>
    child.querySelector<HTMLIFrameElement>(".inkbook-text-input-frame")?.contentDocument;
  const inputNode = () => inputDocument()?.querySelector<HTMLElement>(".cm-editor") ?? null;
  return {
    ...state,
    ...harness,
    child,
    begin,
    inputNode,
    current: () => EditorView.findFromDOM(inputNode()!)!,
  };
}

async function lassoText(state: ReturnType<typeof controllerSource>) {
  lassoTextSelection(state.controller);
  await vi.waitFor(() =>
    expect(state.renderer.setSelectedElements).toHaveBeenLastCalledWith(
      new Set([state.element.id]),
    ),
  );
}

it.each(["before-mount", "child-before-ready"] as const)(
  "keeps one native editor when a lasso-selected double tap continues %s",
  async (stage) => {
    const state = controllerSource();
    await lassoText(state);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(TextFieldEditor.prototype, "ready", "get").mockReturnValue(ready);
    const edit = vi.spyOn(ActiveTextSession.prototype, "edit");
    tapSelectedText(state.controller);
    if (stage === "before-mount") tapSelectedText(state.controller);
    else {
      await vi.waitFor(() => expect(state.inputNode()).not.toBeNull());
      const down = textActivationPointer("pointerdown", "mouse", { clientX: 60, clientY: 0 });
      state.child.body.dispatchEvent(down);
      state.child.body.dispatchEvent(
        textActivationPointer("pointerup", "mouse", { clientX: 60, clientY: 0 }),
      );
      expect(down.defaultPrevented).toBe(true);
    }
    release();
    await vi.waitFor(() => expect(presentationReady(state)).toBe(true));
    expect(edit).toHaveBeenCalledExactlyOnceWith(state.element.id, state.element.source.length);
    expect(state.begin).toHaveBeenCalledOnce();
    const input = state.current();
    expect(input.state.selection.main.head).toBe(state.element.source.length);
    const normal = textActivationPointer("pointerdown", "mouse", { clientX: 60, clientY: 0 });
    input.contentDOM.dispatchEvent(normal);
    expect(normal.defaultPrevented).toBe(false);
    expect(state.current()).toBe(input);
    state.child.body.dispatchEvent(
      textActivationPointer("pointerdown", "mouse", { clientX: 500, clientY: 500 }),
    );
    await vi.waitFor(() => expect(state.inputNode()).toBeNull());
    expect(state.error).not.toHaveBeenCalled();
  },
);

function presentationReady(state: ReturnType<typeof controllerSource>) {
  return (
    state.child.querySelector("foreignObject")?.hasAttribute("data-inkbook-text-editor-ready") ===
    true
  );
}

it("keeps first-click selection and opens the following click once at the complete source end", async () => {
  const state = controllerSource();
  const edit = vi.spyOn(ActiveTextSession.prototype, "edit");
  tapSelectedText(state.controller);
  expect(edit).not.toHaveBeenCalled();
  expect(state.inputNode()).toBeNull();
  tapSelectedText(state.controller);
  await vi.waitFor(() => expect(presentationReady(state)).toBe(true));
  expect(edit).toHaveBeenCalledExactlyOnceWith(state.element.id, state.element.source.length);
  expect(state.begin).toHaveBeenCalledOnce();
  expect(state.current().state.selection.main.head).toBe(state.element.source.length);
});
