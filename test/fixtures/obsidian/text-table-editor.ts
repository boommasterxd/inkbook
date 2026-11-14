import { expect, vi } from "vitest";
import {
  TextFieldEditor,
  type TextFieldEditorOptions,
} from "../../../src/obsidian/text/editor/text-field-editor";
import { parseTextMarkdown } from "../domain/text-source";
import { ManualFrameScheduler } from "./manual-frame-scheduler";
import { workSchedulerFromFrames } from "./work-scheduler";
import { textElement } from "../../unit/domain/schema/fixtures";
import { createTextTableUi } from "../../../src/obsidian/embeds/active-editor/text-table-menu";
import { createOwnedMenuFactory } from "../../../src/obsidian/menus/owned-menu-factory";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";

export const TABLE_SOURCE = "| Name | Value |\n| :--- | ---: |\n| one | $x$ |\n\nafter";
const editors: TextFieldEditor[] = [];

export async function mount(
  content = TABLE_SOURCE,
  menus = false,
  onScrollIntoView?: TextFieldEditorOptions["onScrollIntoView"],
) {
  const container = document.createElement("div");
  if (menus) {
    installObsidianDomHelpers();
    container.dataset.inkbookMotion = "reduced";
  }
  document.body.append(container);
  const frames = new ManualFrameScheduler();
  const scheduler = workSchedulerFromFrames(frames);
  const onError = vi.fn();
  const onUndoRedo = vi.fn<NonNullable<TextFieldEditorOptions["onUndoRedo"]>>();
  const renderTable = vi.fn<NonNullable<TextFieldEditorOptions["renderTable"]>>(async (block) => ({
    node: document.createElement("div"),
    rowHeights: block.table!.rows.map(() => 30),
  }));
  const editor = new TextFieldEditor({
    container,
    element: { ...textElement(), source: content },
    scheduler,
    ...(menus
      ? {
          tableUi: createTextTableUi({
            owner: container,
            factory: createOwnedMenuFactory({ anchor: container, workScheduler: scheduler }),
          }),
        }
      : {}),
    renderTable,
    onChange: vi.fn(),
    onFinish: vi.fn(),
    onUndoRedo,
    onError,
    ...(onScrollIntoView === undefined ? {} : { onScrollIntoView }),
  });
  editors.push(editor);
  editor.view.dispatch({ selection: { anchor: content.length } });
  const settle = async () => {
    await editor.flushChanges();
    let idle = 0;
    for (let turn = 0; turn < 32; turn += 1) {
      if (frames.pendingCount) {
        idle = 0;
        frames.runNext();
      } else idle += 1;
      await Promise.resolve();
      if (idle === 3) return;
    }
    throw new Error("Table editing work did not settle.");
  };
  await settle();
  const expectUnchangedPreview = async () => {
    await settle();
    expect(editor.view.contentDOM.querySelector("table")).not.toBeNull();
    expect(editor.source).toBe(content);
    expect(onError).not.toHaveBeenCalled();
  };
  return { editor, container, settle, expectUnchangedPreview, onError, onUndoRedo, renderTable };
}

export function parsedTable(editor: TextFieldEditor) {
  const parsed = parseTextMarkdown(editor.source, {
    style: textElement().style,
    ranges: editor.ranges,
    paragraphs: editor.paragraphs,
  });
  const block = parsed.blocks.find((candidate) => candidate.table);
  if (!block?.table) throw new Error("Expected valid canonical table source.");
  return { block, table: block.table };
}

export function activate(
  editor: TextFieldEditor,
  row: number,
  column: number,
): TextFieldEditor["inputView"] {
  const button = editor.view.contentDOM.querySelector<HTMLButtonElement>(
    `button[data-inkbook-table-row="${String(row)}"][data-inkbook-table-column="${String(column)}"]`,
  );
  if (!button) throw new Error("Expected a reachable table cell.");
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(editor.inputView).not.toBe(editor.view);
  expect(editor.inputView.hasFocus).toBe(true);
  return editor.inputView;
}

export function clickAction(editor: TextFieldEditor, label: string): void {
  const button = editor.view.dom.ownerDocument.body.querySelector<HTMLButtonElement>(
    `.inkbook-text-table-controls button[aria-label="${label}"]`,
  );
  if (!button) throw new Error("Expected an accessible table action.");
  button.click();
}

export function disposeTableEditors(): void {
  for (const editor of editors.splice(0)) editor.dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
}
