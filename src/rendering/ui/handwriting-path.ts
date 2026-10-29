import { HANDWRITING_GLYPHS } from "./handwriting-glyphs";

export interface HandwritingStroke {
  readonly path: string;
  readonly progressStart: number;
  readonly progressEnd: number;
}

interface HandwritingDrawing {
  readonly width: number;
  readonly height: number;
  readonly strokes: readonly HandwritingStroke[];
}

/** Fixed, short onboarding labels only; callers retain the result for their lifetime. */
export function handwritingDrawing(text: string): HandwritingDrawing {
  if (text.length > 120) throw new RangeError("Handwriting labels must not exceed 120 characters");
  const paths: { path: string; weight: number }[] = [];
  let cursor = 4;
  for (const [index, character] of [...text].entries()) {
    if (character === " ") {
      cursor += 4.3;
      continue;
    }
    const glyph = HANDWRITING_GLYPHS[character];
    if (!glyph) throw new Error(`Unsupported handwriting glyph: ${character}`);
    for (const source of glyph.paths) paths.push(transformStroke(source, cursor, index));
    cursor += glyph.advance + 0.45;
  }
  const totalWeight = paths.reduce((total, stroke) => total + stroke.weight, 0);
  let progress = 0;
  const strokes = paths.map(({ path, weight }) => {
    const progressStart = progress;
    progress += weight / totalWeight;
    return { path, progressStart, progressEnd: progress };
  });
  return { width: cursor + 5, height: 20, strokes };
}

function transformStroke(source: string, cursor: number, index: number) {
  const height = 1 + 0.025 * Math.sin(index * 1.83);
  const baseline = Math.sin(index * 1.47) * 0.25;
  let previous: { x: number; y: number } | undefined;
  let weight = 0;
  const path = source.replace(
    /(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g,
    (_pair, a: string, b: string) => {
      const y = Number(b);
      const point = { x: cursor + Number(a) + (10 - y) * 0.08, y: 2.5 + y * height + baseline };
      // Control-polygon lengths allocate writing time without sampling the curve.
      if (previous) weight += Math.hypot(point.x - previous.x, point.y - previous.y);
      previous = point;
      return `${Number(point.x.toFixed(3))},${Number(point.y.toFixed(3))}`;
    },
  );
  return { path, weight: Math.max(weight, 0.35) };
}
