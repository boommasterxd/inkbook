import type { EditorView, ViewUpdate } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { CodeMirrorInputProbeBinding } from "../../../../src/adapters/obsidian/editor-history";
import { EditorInputProbe } from "../../../../src/input/phase-zero";

const COMPOSITION_ABUSE_EVENT_COUNT = 1_000;

interface MutableFakeView {
  readonly dom: EventTarget;
  readonly visibleRanges: readonly {
    readonly from: number;
    readonly to: number;
  }[];
  state: {
    readonly doc: { readonly length: number };
    readonly selection: {
      readonly main: { readonly from: number; readonly to: number };
    };
  };
  requestMeasure(request: { read(view: EditorView): void }): void;
}

function createView(): MutableFakeView {
  const view: MutableFakeView = {
    dom: new EventTarget(),
    requestMeasure(request): void {
      request.read(view as unknown as EditorView);
    },
    state: {
      doc: { length: 20 },
      selection: { main: { from: 1, to: 1 } },
    },
    visibleRanges: [{ from: 0, to: 10 }],
  };
  return view;
}

function update(
  view: MutableFakeView,
  options: { readonly docChanged?: boolean; readonly selectionSet?: boolean },
): ViewUpdate {
  return {
    docChanged: options.docChanged ?? false,
    selectionSet: options.selectionSet ?? false,
    state: view.state,
    viewportChanged: false,
  } as unknown as ViewUpdate;
}

describe("CodeMirrorInputProbeBinding", () => {
  it("observes viewport, selection, IME, keyboard input, and disposal", () => {
    const view = createView();
    const probe = new EditorInputProbe();
    const binding = new CodeMirrorInputProbeBinding(
      view as unknown as EditorView,
      probe,
    );

    view.dom.dispatchEvent(new Event("selectstart"));
    view.state = {
      ...view.state,
      selection: { main: { from: 1, to: 4 } },
    };
    binding.update(update(view, { selectionSet: true }));

    view.dom.dispatchEvent(new Event("compositionstart"));
    view.dom.dispatchEvent(new Event("compositionupdate"));
    binding.update(update(view, { docChanged: true }));
    view.dom.dispatchEvent(new Event("compositionend"));

    view.dom.dispatchEvent(new Event("beforeinput"));
    view.dom.dispatchEvent(new Event("input"));
    binding.update(update(view, { docChanged: true }));

    expect(probe.report()).toMatchObject({
      codeMirrorVirtualizationPasses: true,
      complete: true,
      imePasses: true,
      nativeTextSelectionPasses: true,
      softwareKeyboardPasses: true,
    });

    binding.dispose();
    binding.dispose();
    expect(probe.report().disposed).toBe(true);
  });

  it("ignores prevented selections and inert updates after disposal", () => {
    const view = createView();
    const probe = new EditorInputProbe();
    const binding = new CodeMirrorInputProbeBinding(
      view as unknown as EditorView,
      probe,
    );
    const prevented = new Event("selectstart", { cancelable: true });
    prevented.preventDefault();
    view.dom.dispatchEvent(prevented);
    binding.dispose();
    binding.update(update(view, { docChanged: true, selectionSet: true }));

    expect(probe.report()).toMatchObject({
      complete: false,
      nativeTextSelectionPasses: false,
    });
  });

  it("bounds an unterminated composition event storm and rejects its proof", () => {
    const view = createView();
    const probe = new EditorInputProbe();
    const binding = new CodeMirrorInputProbeBinding(
      view as unknown as EditorView,
      probe,
    );

    view.dom.dispatchEvent(new Event("compositionstart"));
    for (let index = 0; index < COMPOSITION_ABUSE_EVENT_COUNT; index += 1) {
      view.dom.dispatchEvent(new Event("compositionupdate"));
    }
    binding.update(update(view, { docChanged: true }));
    view.dom.dispatchEvent(new Event("compositionend"));

    expect(probe.report().imePasses).toBe(false);
    binding.dispose();
  });
});
