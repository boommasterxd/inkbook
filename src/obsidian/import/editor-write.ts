import { MarkdownView, type App } from "obsidian";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

/** Includes active source editors in detached panes and pop-outs; Reading buffers are stale. */
export function importNoteViews(app: App, path: string): MarkdownView[] {
  const views: MarkdownView[] = [];
  app.workspace.iterateAllLeaves((leaf) => {
    if (
      leaf.view instanceof MarkdownView &&
      leaf.view.file?.path === path &&
      leaf.view.getMode() === "source"
    )
      views.push(leaf.view);
  });
  return views;
}

export function currentImportNote(app: App, path: string): string | undefined {
  const views = importNoteViews(app, path);
  const value = views[0]?.editor.getValue();
  if (views.some((view) => view.editor.getValue() !== value)) {
    throw new Error("Conflicting open note buffers. Save or close the note before importing.");
  }
  return value;
}

async function changedRange(expected: string, next: string, scheduler: WorkScheduler) {
  let start = 0;
  while (start < expected.length && start < next.length && expected[start] === next[start]) {
    start += 1;
    if (start % 4096 === 0) {
      const pending = scheduler.checkpoint();
      if (pending !== undefined) await pending;
    }
  }
  let beforeEnd = expected.length;
  let afterEnd = next.length;
  while (beforeEnd > start && afterEnd > start && expected[beforeEnd - 1] === next[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
    if (beforeEnd % 4096 === 0) {
      const pending = scheduler.checkpoint();
      if (pending !== undefined) await pending;
    }
  }
  return { start, beforeEnd, text: next.slice(start, afterEnd) };
}

/** Returns undefined only when no live editor owns this Markdown document. */
export async function writeOpenImportNote(options: {
  readonly app: App;
  readonly path: string;
  readonly expected: string;
  readonly next: string;
  readonly workScheduler: WorkScheduler;
}): Promise<boolean | undefined> {
  const views = importNoteViews(options.app, options.path);
  if (views.length === 0) return undefined;
  if (views.some((view) => view.editor.getValue() !== options.expected)) return false;
  const change = await changedRange(options.expected, options.next, options.workScheduler);
  const currentViews = importNoteViews(options.app, options.path);
  if (currentViews.length !== views.length || views.some((view) => !currentViews.includes(view)))
    return false;
  if (views.some((view) => view.editor.getValue() !== options.expected)) return false;
  for (const view of views) {
    if (view.file?.path !== options.path || view.getMode() !== "source") return false;
    const editor = view.editor;
    // A shared editor document may already have received the preceding transaction.
    if (editor.getValue() === options.next) continue;
    if (editor.getValue() !== options.expected) return false;
    editor.transaction(
      {
        changes: [
          {
            from: editor.offsetToPos(change.start),
            to: editor.offsetToPos(change.beforeEnd),
            text: change.text,
          },
        ],
      },
      "inkbook-import",
    );
  }
  for (const view of views) {
    if (
      view.file?.path !== options.path ||
      view.getMode() !== "source" ||
      view.editor.getValue() !== options.next
    )
      return false;
    await view.save();
  }
  return views.every(
    (view) =>
      view.file?.path === options.path &&
      view.getMode() === "source" &&
      view.editor.getValue() === options.next,
  );
}
