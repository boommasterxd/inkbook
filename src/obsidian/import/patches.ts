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

interface ContextMatch {
  at?: number | null;
}

interface ContextGroup {
  readonly prefixLength: number;
  readonly suffixLength: number;
  readonly matches: Map<string, ContextMatch>;
}

function registerContext(groups: Map<string, ContextGroup>, patch: InkImportPatch): ContextMatch {
  const prefixLength = patch.prefix.length;
  const suffixLength = patch.suffix.length;
  const lengths = `${prefixLength}:${suffixLength}`;
  let group = groups.get(lengths);
  if (group === undefined) {
    group = { prefixLength, suffixLength, matches: new Map() };
    groups.set(lengths, group);
  }
  // The fixed lengths in this group make the concatenated context unambiguous.
  const key = patch.prefix + patch.suffix;
  let match = group.matches.get(key);
  if (match === undefined) {
    match = {};
    group.matches.set(key, match);
  }
  return match;
}

function matchOccurrence(note: string, start: number, end: number, group: ContextGroup): void {
  const { prefixLength, suffixLength, matches } = group;
  if (start < prefixLength || end + suffixLength > note.length) return;
  const key = note.slice(start - prefixLength, start) + note.slice(end, end + suffixLength);
  const match = matches.get(key);
  if (match === undefined) return;
  if (match.at === undefined) match.at = start;
  else {
    match.at = null;
    matches.delete(key);
  }
}

async function locateContexts(
  note: string,
  replacement: string,
  groups: Map<string, ContextGroup>,
  scheduler: WorkScheduler,
): Promise<void> {
  if (replacement.length === 0) throw new Error("An empty replacement cannot be reversed.");
  let offset = 0;
  while (offset <= note.length) {
    const pause = scheduler.checkpoint(undefined, "background");
    if (pause !== undefined) await pause;
    const at = note.indexOf(replacement, offset);
    if (at === -1) break;
    offset = at + replacement.length;
    for (const [lengths, group] of groups) {
      matchOccurrence(note, at, offset, group);
      if (group.matches.size === 0) groups.delete(lengths);
    }
    if (groups.size === 0) return;
  }
}

export async function reverseImportPatches(
  note: string,
  patches: readonly InkImportPatch[],
  scheduler: WorkScheduler,
): Promise<string> {
  const replacements = new Map<string, Map<string, ContextGroup>>();
  const requested = [];
  for (const patch of patches) {
    if (patch.status === "undone") continue;
    const pause = scheduler.checkpoint(undefined, "background");
    if (pause !== undefined) await pause;
    let groups = replacements.get(patch.after);
    if (groups === undefined) {
      groups = new Map();
      replacements.set(patch.after, groups);
    }
    requested.push({ patch, match: registerContext(groups, patch) });
  }
  for (const [replacement, groups] of replacements)
    await locateContexts(note, replacement, groups, scheduler);

  const changes = new Map<number, InkImportPatch>();
  for (const { patch, match } of requested) {
    const at = match.at;
    if (typeof at !== "number" || changes.has(at)) patch.status = "conflict";
    else changes.set(at, patch);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const [at, patch] of [...changes].sort(([left], [right]) => left - right)) {
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
