import type { InkImportPatch, InkImportReference } from "./types";
import { findMarkdownInkbookEmbeds } from "../embeds/markdown-embed";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

export function createImportPatch(
  reference: InkImportReference,
  embed: string,
  note: string,
): InkImportPatch {
  const parsed = findMarkdownInkbookEmbeds(embed);
  if (parsed.length !== 1 || parsed[0]?.markdown !== embed)
    throw new Error("Obsidian generated an invalid native embed.");
  return {
    sourcePath: reference.sourcePath,
    start: reference.start,
    before: reference.original,
    after: embed,
    prefix: note.slice(Math.max(0, reference.start - 80), reference.start),
    suffix: note.slice(
      reference.start + reference.original.length,
      reference.start + reference.original.length + 80,
    ),
    status: "pending",
  };
}

export function applyImportPatches(note: string, patches: readonly InkImportPatch[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const patch of [...patches].sort((left, right) => left.start - right.start)) {
    if (
      patch.start < cursor ||
      note.slice(patch.start, patch.start + patch.before.length) !== patch.before
    ) {
      throw new Error("An import reference changed before replacement.");
    }
    parts.push(note.slice(cursor, patch.start), patch.after);
    cursor = patch.start + patch.before.length;
  }
  parts.push(note.slice(cursor));
  return parts.join("");
}

async function uniquePatchPosition(
  note: string,
  patch: InkImportPatch,
  scheduler: WorkScheduler,
): Promise<number | undefined> {
  if (patch.after.length === 0) throw new Error("An empty replacement cannot be reversed.");
  const positions: number[] = [];
  let offset = 0;
  while (offset <= note.length) {
    const pause = scheduler.checkpoint(undefined, "background");
    if (pause !== undefined) await pause;
    const at = note.indexOf(patch.after, offset);
    if (at === -1) break;
    const before = note.slice(Math.max(0, at - patch.prefix.length), at);
    const after = note.slice(
      at + patch.after.length,
      at + patch.after.length + patch.suffix.length,
    );
    if (before === patch.prefix && after === patch.suffix) positions.push(at);
    if (positions.length > 1) return undefined;
    offset = at + patch.after.length;
  }
  return positions[0];
}

export async function reverseImportPatches(
  note: string,
  patches: readonly InkImportPatch[],
  scheduler: WorkScheduler,
): Promise<string> {
  const changes: { readonly patch: InkImportPatch; readonly at: number }[] = [];
  for (const patch of patches) {
    if (patch.status === "undone") continue;
    const at = await uniquePatchPosition(note, patch, scheduler);
    if (at === undefined || changes.some((change) => change.at === at)) patch.status = "conflict";
    else changes.push({ patch, at });
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const { patch, at } of changes.sort((left, right) => left.at - right.at)) {
    parts.push(note.slice(cursor, at), patch.before);
    cursor = at + patch.after.length;
    patch.status = "undone";
  }
  parts.push(note.slice(cursor));
  return parts.join("");
}

export function withImportedContexts(
  note: string,
  patches: readonly InkImportPatch[],
): InkImportPatch[] {
  let delta = 0;
  return [...patches]
    .sort((left, right) => left.start - right.start)
    .map((patch) => {
      const at = patch.start + delta;
      delta += patch.after.length - patch.before.length;
      return {
        ...patch,
        prefix: note.slice(Math.max(0, at - 80), at),
        suffix: note.slice(at + patch.after.length, at + patch.after.length + 80),
      };
    });
}
