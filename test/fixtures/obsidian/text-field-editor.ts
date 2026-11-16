import { afterEach, vi } from "vitest";
import {
  TextFieldEditor,
  type TextFieldEditorOptions,
} from "../../../src/obsidian/text/editor/text-field-editor";
import { textElement } from "../../unit/domain/schema/fixtures";
import { ManualFrameScheduler } from "./manual-frame-scheduler";
import { workSchedulerFromFrames } from "./work-scheduler";

export function mountTextFieldEditor(
  editors: TextFieldEditor[],
  source = "Hello",
  overrides: Partial<TextFieldEditorOptions> = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  const frames = new ManualFrameScheduler();
  const element = { ...textElement(), source };
  const onChange = vi.fn<TextFieldEditorOptions["onChange"]>();
  const onSelectionChange = vi.fn();
  const onUndoRedo = vi.fn();
  const onFinish = vi.fn();
  const onError = vi.fn();
  const scheduler = workSchedulerFromFrames({
    requestAnimationFrame: frames.requestFrame.bind(frames),
    cancelAnimationFrame: frames.cancelFrame.bind(frames),
  });
  const editor = new TextFieldEditor({
    container,
    element,
    scheduler,
    onChange,
    onSelectionChange,
    onUndoRedo,
    onFinish,
    onError,
    ...overrides,
  });
  editors.push(editor);
  const flush = () => {
    while (frames.pendingCount) frames.runNext();
  };
  return {
    editor,
    container,
    frames,
    flush,
    element,
    onChange,
    onSelectionChange,
    onUndoRedo,
    onFinish,
    onError,
  };
}

export function createTextFieldEditorFixture() {
  const editors: TextFieldEditor[] = [];
  afterEach(() => {
    for (const editor of editors.splice(0)) editor.dispose();
    document.body.replaceChildren();
  });
  return (source = "Hello", overrides: Partial<TextFieldEditorOptions> = {}) =>
    mountTextFieldEditor(editors, source, overrides);
}
