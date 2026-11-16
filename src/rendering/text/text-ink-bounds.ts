import type { TextElementV2, TextLayoutRunV2, TextStyleV2 } from "../../domain/schema/public";
import { canonicalizeGeometryNumber as canonical } from "../../domain/schema/canonical";
import type { MeasuredText, TextLayoutPorts, TextMeasurer } from "./text-layout-types";
import { admitTextLayout, assertTextLayoutActive } from "./text-layout-types";

/** SVG spacingAndGlyphs scales the complete shaped run to its persisted advance. */
export function measureTextRunInkBounds(
  run: TextLayoutRunV2,
  baseStyle: TextStyleV2,
  measure: TextMeasurer,
  measured?: MeasuredText,
): TextLayoutRunV2["inkBounds"] {
  const metrics =
    measured ?? measure.measure(run.text, { ...baseStyle, ...run.style }, run.fontResourceId);
  const bounds = metrics.inkBounds;
  if (bounds === undefined) return undefined;
  const scale =
    run.text.length > 0 && run.width > 0 && metrics.width > 0 ? run.width / metrics.width : 1;
  return {
    minX: canonical(Math.floor(bounds.minX * scale * 1000) / 1000),
    minY: canonical(Math.floor(bounds.minY * 1000) / 1000),
    maxX: canonical(Math.ceil(bounds.maxX * scale * 1000) / 1000),
    maxY: canonical(Math.ceil(bounds.maxY * 1000) / 1000),
  };
}

/** Enriches legacy layout without reflow, changing advances, or moving its geometry. */
export async function prepareTextInkBounds(
  element: TextElementV2,
  ports: Pick<TextLayoutPorts, "measure" | "scheduler" | "signal">,
): Promise<TextElementV2> {
  assertTextLayoutActive(ports.signal);
  let changed = false;
  const lines: TextElementV2["layout"]["lines"] = [];
  for (const line of element.layout.lines) {
    const runs: TextLayoutRunV2[] = [];
    let lineChanged = false;
    for (const run of line.runs) {
      const handoff = admitTextLayout(ports);
      if (handoff !== undefined) await handoff;
      const inkBounds = run.inkBounds ?? measureTextRunInkBounds(run, element.style, ports.measure);
      if (run.inkBounds === undefined && inkBounds !== undefined) {
        runs.push({ ...run, inkBounds });
        lineChanged = true;
      } else runs.push(run);
    }
    lines.push(lineChanged ? { ...line, runs } : line);
    changed ||= lineChanged;
  }
  return changed ? { ...element, layout: { ...element.layout, lines } } : element;
}
