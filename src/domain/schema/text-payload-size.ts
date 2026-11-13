interface BackgroundPayload {
  readonly backgroundColor?: { readonly type: string; readonly value?: string } | null;
  readonly backgroundOpacity?: number;
}

interface TextPayloadInput {
  readonly id: string;
  readonly source: string;
  readonly style: { readonly fontFamily: string };
  readonly ranges: readonly { readonly style: BackgroundPayload }[];
  readonly paragraphs: readonly unknown[];
  readonly layout: {
    readonly lines: readonly {
      readonly runs: readonly {
        readonly text: string;
        readonly style?: { readonly fontFamily?: string } & BackgroundPayload;
      }[];
    }[];
    readonly math?: readonly { readonly paths: readonly { readonly d: string }[] }[];
    readonly tables?: readonly { readonly rowHeights: readonly number[] }[];
  };
}

const layoutPayloadBytes = new WeakMap<object, number>();

/** Records work already observed by complete semantic validation of the same layout. */
export function retainValidatedTextLayoutBytes(layout: object, bytes: number): void {
  layoutPayloadBytes.set(layout, bytes);
}

/** The immutable retained layout permits reuse across moves, paint and history records. */
export function textElementPayloadBytes(
  element: TextPayloadInput,
  preparedLayoutBytes?: number,
): number {
  return (
    256 +
    element.id.length * 2 +
    element.source.length * 2 +
    element.style.fontFamily.length * 2 +
    element.ranges.length * 256 +
    element.ranges.reduce((bytes, range) => bytes + textBackgroundPayloadBytes(range.style), 0) +
    element.paragraphs.length * 48 +
    (preparedLayoutBytes ?? textLayoutBytes(element.layout))
  );
}

function textLayoutBytes(layout: TextPayloadInput["layout"]): number {
  const cached = Object.isFrozen(layout) ? layoutPayloadBytes.get(layout) : undefined;
  if (cached !== undefined) return cached;
  let bytes = 0;
  for (const line of layout.lines) {
    bytes += 64;
    for (const run of line.runs)
      bytes +=
        128 +
        run.text.length * 2 +
        (run.style?.fontFamily?.length ?? 0) * 2 +
        textBackgroundPayloadBytes(run.style);
  }
  for (const math of layout.math ?? [])
    for (const path of math.paths) bytes += 64 + path.d.length * 2;
  for (const table of layout.tables ?? []) bytes += 128 + table.rowHeights.length * 8;
  if (Object.isFrozen(layout)) layoutPayloadBytes.set(layout, bytes);
  return bytes;
}

export function textBackgroundPayloadBytes(style: BackgroundPayload | undefined): number {
  return (
    (style?.backgroundColor === undefined
      ? 0
      : 32 + (style.backgroundColor?.value?.length ?? 0) * 2) +
    (style?.backgroundOpacity === undefined ? 0 : 8)
  );
}
