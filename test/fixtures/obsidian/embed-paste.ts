import type { Editor, EditorPosition } from "obsidian";
import { vi } from "vitest";

import { EmbedPasteController } from "../../../src/obsidian/commands/embed-paste";
import { ownedFileRead } from "./owned-file";

export class FakeEditor {
  content: string;
  from: EditorPosition;
  to: EditorPosition;
  readonly replacements: string[] = [];

  constructor(content = "", from = 0, to = from) {
    this.content = content;
    this.from = { ch: from, line: 0 };
    this.to = { ch: to, line: 0 };
  }

  getCursor(side?: "anchor" | "from" | "head" | "to"): EditorPosition {
    return side === "to" || side === "head" ? this.to : this.from;
  }

  getRange(from: EditorPosition, to: EditorPosition): string {
    return this.content.slice(from.ch, to.ch);
  }

  getValue(): string {
    return this.content;
  }

  replaceRange(replacement: string, from: EditorPosition, to = from): void {
    this.replacements.push(replacement);
    this.content = this.content.slice(0, from.ch) + replacement + this.content.slice(to.ch);
    const cursor = from.ch + replacement.length;
    this.from = { ch: cursor, line: 0 };
    this.to = this.from;
  }
}

export const CLIPBOARD = "!inkbook[[drawings/source.svg]]";
export const SOURCE = '<svg data-inkbook-version="1"></svg>';

export function pasteRequest(editor: FakeEditor, overrides: Record<string, unknown> = {}) {
  return {
    clipboardText: CLIPBOARD,
    editor: editor as unknown as Editor,
    insideInkWidget: false,
    sourcePath: "notes/page.md",
    ...overrides,
  };
}

export function guardedRead(path: string, content: string) {
  return {
    content,
    identity: { ctime: 0, mtime: 0, path, size: content.length },
    materialization: "host-full-read-not-bounded" as const,
    stabilityEvidence: "object-identity-and-stat-unchanged" as const,
  };
}

export function pasteHarness(
  choice: "duplicate" | "reference" | null,
  confirmedOutput?: { matchesConfirmedOutput(read: ReturnType<typeof guardedRead>): boolean },
) {
  const events: string[] = [];
  const create = vi.fn(async (path: string, content: string, _maximumBytes: number) => {
    events.push(`create:${path}:${content}`);
    events.push(`read:${path}`);
    return guardedRead(path, content);
  });
  const read = vi.fn(async (path: string) => {
    events.push(`read:${path}`);
    return guardedRead(path, SOURCE);
  });
  const validate = vi.fn(async (content: string) => {
    events.push(`validate:${content}`);
    return true;
  });
  const choose = vi.fn(async () => {
    events.push("choose");
    return choice;
  });
  const trash = vi.fn(async (path: string) => {
    events.push(`trash:${path}`);
  });
  const preparePath = vi.fn(async () => {
    events.push("place");
    return "drawings/duplicate.svg";
  });
  const controller = new EmbedPasteController({
    ...(confirmedOutput === undefined ? {} : { confirmedOutput }),
    choices: { choose },
    documents: {
      createOwnedAndReadBack: async (path, content, maximumBytes, onCreated) =>
        ownedFileRead(path, await create(path, content, maximumBytes), onCreated),
      readWithMetadataGuard: read,
    },
    links: {
      generateEmbed: (path) => {
        events.push(`link:${path}`);
        return `!inkbook[[${path}]]`;
      },
      resolveLinkTarget: (linkpath) =>
        linkpath === "drawings/source.svg" ? { path: "drawings/source.svg" } : null,
    },
    placement: { preparePath },
    trash: { trashCreated: (created) => trash(created.file.path) },
    validation: { validate },
  });
  return { choose, controller, create, events, preparePath, read, trash, validate };
}
