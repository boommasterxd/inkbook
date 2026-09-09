import type { Editor, MarkdownFileInfo, MarkdownView } from "obsidian";

import type { EmptyLineInsertionController } from "./empty-line-insertion";
import type { InkbookInsertionCommand } from "./command-registry";

export interface PenTapPointerSample {
  readonly button: number;
  readonly buttons: number;
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly timeStamp: number;
}

export interface PenTapTarget {
  readonly editor: Editor;
  readonly context: MarkdownView | MarkdownFileInfo;
  readonly insideInkWidget: boolean;
  readonly line: number;
  readonly sourcePath: string;
}

interface PendingPenTap {
  readonly sample: PenTapPointerSample;
  readonly target: PenTapTarget;
}

function isRegularPenTip(sample: PenTapPointerSample): boolean {
  return sample.pointerType === "pen" && sample.button === 0 && sample.buttons === 1;
}

export class PenTapInsertionController {
  readonly #insertion: Pick<EmptyLineInsertionController, "canInsertAtLine">;
  readonly #isEnabled: () => boolean;
  readonly #command: InkbookInsertionCommand;
  #pending: PendingPenTap | undefined;

  constructor(
    insertion: Pick<EmptyLineInsertionController, "canInsertAtLine">,
    isEnabled: () => boolean,
    command: InkbookInsertionCommand,
  ) {
    this.#insertion = insertion;
    this.#command = command;
    this.#isEnabled = isEnabled;
  }

  begin(sample: PenTapPointerSample, target: PenTapTarget): boolean {
    this.#pending = undefined;
    if (!this.#isEnabled() || target.insideInkWidget || !isRegularPenTip(sample)) return false;
    if (!this.#insertion.canInsertAtLine(target.editor, target.sourcePath, target.line))
      return false;
    this.#pending = { sample, target };
    return true;
  }

  cancel(pointerId?: number): void {
    if (pointerId === undefined || this.#pending?.sample.pointerId === pointerId) {
      this.#pending = undefined;
    }
  }

  complete(sample: PenTapPointerSample): boolean {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending === undefined || pending.sample.pointerId !== sample.pointerId) return false;
    if (
      !this.#isEnabled() ||
      sample.pointerType !== "pen" ||
      sample.button !== 0 ||
      sample.buttons !== 0
    ) {
      return false;
    }
    const duration = sample.timeStamp - pending.sample.timeStamp;
    const movement = Math.hypot(
      sample.clientX - pending.sample.clientX,
      sample.clientY - pending.sample.clientY,
    );
    if (duration < 0 || duration > 500 || movement > 10) return false;
    const { editor, sourcePath, line, context } = pending.target;
    if (context.file?.path !== sourcePath) return false;
    if (!this.#insertion.canInsertAtLine(editor, sourcePath, line)) return false;
    editor.setCursor({ line, ch: 0 });
    return this.#command.editorCheckCallback(false, editor, context);
  }
}
