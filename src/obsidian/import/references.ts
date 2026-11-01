import type { InkImportReference } from "./types";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

interface Candidate {
  readonly start: number;
  readonly original: string;
  readonly link: string;
  readonly legacy: boolean;
  readonly description?: string;
}

interface ParserState {
  frontmatter: boolean;
  comment: boolean;
  fence?: {
    readonly marker: string;
    readonly start: number;
    readonly body: number;
    readonly ink: boolean;
  };
}

function suppressedLine(line: string, start: number, state: ParserState): boolean {
  if (start === 0 && line.replace(/^\uFEFF/u, "") === "---") {
    state.frontmatter = true;
    return true;
  }
  if (state.frontmatter) {
    if (line === "---" || line === "...") state.frontmatter = false;
    return true;
  }
  if (!state.comment && !line.includes("<!--")) return false;
  const opening: number = state.comment ? 0 : line.indexOf("<!--") + 4;
  state.comment = line.indexOf("-->", opening) === -1;
  return true;
}

function legacyLink(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (typeof value !== "object" || value === null || !("filepath" in value)) return undefined;
    return typeof value.filepath === "string" && /\.writing$/iu.test(value.filepath)
      ? value.filepath
      : undefined;
  } catch {
    return undefined;
  }
}

function imageLink(
  line: string,
): { readonly link: string; readonly description: string } | undefined {
  const match =
    /^ {0,3}!\[([^\]\r\n]*)\]\((?:<([^>\r\n]+)>|([^\s()]+))\) +\[Edit Writing\]\((https:\/\/[^\s)]+)\)[ \t]*$/u.exec(
      line,
    );
  if (match === null) return undefined;
  const link = match[2] ?? match[3];
  if (link === undefined || !/\.svg$/iu.test(link)) return undefined;
  try {
    const url = new URL(match[4] ?? "");
    if (url.searchParams.get("type") !== "inkWriting") return undefined;
    return { link: decodeURIComponent(link), description: match[1] ?? "" };
  } catch {
    return undefined;
  }
}

function consumeLine(
  note: string,
  raw: string,
  start: number,
  state: ParserState,
): Candidate | undefined {
  const line = raw.replace(/\r?\n$/u, "");
  const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
  const fence = state.fence;
  if (fence !== undefined) {
    if (
      delimiter?.[1]?.startsWith(fence.marker[0] ?? "") !== true ||
      delimiter[1].length < fence.marker.length ||
      delimiter[2]?.trim() !== ""
    )
      return undefined;
    delete state.fence;
    const link =
      fence.ink && start - fence.body <= 8192
        ? legacyLink(note.slice(fence.body, start))
        : undefined;
    return link === undefined
      ? undefined
      : {
          start: fence.start,
          original: note.slice(fence.start, start + line.length),
          link,
          legacy: true,
        };
  }
  if (suppressedLine(line, start, state)) return undefined;
  if (delimiter !== null) {
    state.fence = {
      marker: delimiter[1] ?? "```",
      start,
      body: start + raw.length,
      ink: delimiter[2]?.trim() === "handwritten-ink",
    };
    return undefined;
  }
  const image = line.length <= 8192 ? imageLink(line) : undefined;
  return image === undefined ? undefined : { start, original: line, ...image, legacy: false };
}

export async function findInkCandidates(
  note: string,
  scheduler: WorkScheduler,
  signal?: AbortSignal,
): Promise<readonly Candidate[]> {
  const result: Candidate[] = [];
  const lines = note.matchAll(/[^\n]*(?:\n|$)/gu);
  const state: ParserState = { frontmatter: false, comment: false };
  for (const match of lines) {
    if (match[0] === "" || result.length >= 10_000) break;
    signal?.throwIfAborted();
    const pause = scheduler.checkpoint(signal, "background");
    if (pause !== undefined) await pause;
    const candidate = consumeLine(note, match[0], match.index, state);
    if (candidate !== undefined) result.push(candidate);
  }
  return result;
}

export async function resolveInkReferences(options: {
  readonly note: string;
  readonly notePath: string;
  readonly resolve: (link: string, notePath: string) => string | undefined;
  readonly scheduler: WorkScheduler;
  readonly signal?: AbortSignal;
  readonly unresolved?: (link: string) => void;
}): Promise<readonly (InkImportReference & { readonly legacy: boolean })[]> {
  const result: (InkImportReference & { readonly legacy: boolean })[] = [];
  for (const candidate of await findInkCandidates(
    options.note,
    options.scheduler,
    options.signal,
  )) {
    const sourcePath = options.resolve(candidate.link, options.notePath);
    if (sourcePath === undefined || sourcePath.startsWith("inkbook-imports/")) {
      options.unresolved?.(candidate.link);
      continue;
    }
    result.push({
      notePath: options.notePath,
      start: candidate.start,
      original: candidate.original,
      sourcePath,
      legacy: candidate.legacy,
      ...(candidate.description === undefined ? {} : { description: candidate.description }),
    });
  }
  return result;
}
