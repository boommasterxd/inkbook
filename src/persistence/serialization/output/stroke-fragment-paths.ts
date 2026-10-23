import type { SvgPathPart } from "../../../domain/geometry/svg-path-part";

export interface StrokeFragmentPathRange {
  readonly start: number;
  readonly end: number;
  readonly paint: "fill" | "stroke";
}

/** Reuses only byte ranges recorded by the internal canonical fragment producer. */
export async function readStrokeFragmentPaths(
  fragment: {
    readonly svgUtf8: Uint8Array;
    readonly strokePaths: readonly StrokeFragmentPathRange[] | undefined;
  },
  context: { readonly signal: AbortSignal; checkpoint(): Promise<void> | undefined },
): Promise<readonly SvgPathPart[]> {
  const parts: SvgPathPart[] = [];
  const decoder = new TextDecoder();
  for (const range of fragment.strokePaths ?? []) {
    const chunks: string[] = [];
    for (let start = range.start; start < range.end; start += 64 * 1024) {
      context.signal.throwIfAborted();
      const pending = context.checkpoint();
      if (pending !== undefined) await pending;
      context.signal.throwIfAborted();
      chunks.push(
        decoder.decode(fragment.svgUtf8.subarray(start, Math.min(range.end, start + 64 * 1024))),
      );
      context.signal.throwIfAborted();
    }
    context.signal.throwIfAborted();
    parts.push({ d: chunks.join(""), paint: range.paint });
    context.signal.throwIfAborted();
  }
  context.signal.throwIfAborted();
  return parts;
}
