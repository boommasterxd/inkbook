import type {
  FontResourceV2,
  InkSnapshotV1,
  TextElementV2,
  TextLayoutRunV2,
  TextStyleV2,
} from "../../domain/schema/public";
import { selectFontResources } from "./font-resources";

/** A saved glyph binding owns its face independently of later library additions or regrouping. */
export function textRunFontResource(
  run: TextLayoutRunV2,
  base: TextStyleV2,
  resources: readonly FontResourceV2[],
): FontResourceV2 {
  if (run.fontResourceId !== undefined) {
    const resource = resources.find((candidate) => candidate.id === run.fontResourceId);
    if (resource === undefined)
      throw new RangeError("The bound text font resource is unavailable.");
    return resource;
  }
  const style = { ...base, ...run.style };
  return textStyleFontResource(style, resources);
}

function textStyleFontResource(
  style: TextStyleV2,
  resources: readonly FontResourceV2[],
): FontResourceV2 {
  return selectFontResources(resources, [
    {
      family: style.fontFamily,
      weight: style.bold ? 700 : 400,
      style: style.italic ? "italic" : "normal",
    },
  ])[0]!;
}

/** Bind legacy layout only against its own document resources, never the changing library. */
export function* bindTextElementFontResourcesSteps(
  element: TextElementV2,
  resources: readonly FontResourceV2[],
): Generator<void, TextElementV2> {
  const lines: TextElementV2["layout"]["lines"] = [];
  let changed = false;
  let glyphFace: string | undefined;
  for (const line of element.layout.lines) {
    const runs: TextLayoutRunV2[] = [];
    let lineChanged = false;
    for (const run of line.runs) {
      if (run.text.length > 0) {
        const face = textRunFontResource(run, element.style, resources);
        glyphFace ??= face.id;
        if (run.fontResourceId === undefined) {
          runs.push({ ...run, fontResourceId: face.id });
          changed = lineChanged = true;
        } else runs.push(run);
      } else runs.push(run);
      yield;
    }
    lines.push(lineChanged ? { ...line, runs } : line);
    yield;
  }
  const baseFontResourceId =
    element.layout.baseFontResourceId ??
    glyphFace ??
    textStyleFontResource(element.style, resources).id;
  if (!resources.some((face) => face.id === baseFontResourceId))
    throw new RangeError("The bound text strut font resource is unavailable.");
  changed ||= element.layout.baseFontResourceId !== baseFontResourceId;
  return changed
    ? { ...element, layout: { ...element.layout, baseFontResourceId, lines } }
    : element;
}

export function* bindSnapshotFontResourcesSteps(
  snapshot: InkSnapshotV1,
): Generator<void, InkSnapshotV1> {
  if (snapshot.version === 1) return snapshot;
  const elements: InkSnapshotV1["elements"] = [];
  let changed = false;
  for (const source of snapshot.elements) {
    const element =
      source.kind === "text"
        ? yield* bindTextElementFontResourcesSteps(source, snapshot.fontResources ?? [])
        : source;
    elements.push(element);
    changed ||= element !== source;
  }
  return changed ? { ...snapshot, elements } : snapshot;
}

export function bindSnapshotFontResources(snapshot: InkSnapshotV1): InkSnapshotV1 {
  const steps = bindSnapshotFontResourcesSteps(snapshot);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function textFontBindingMode(
  snapshot: InkSnapshotV1,
): "bound" | "legacy" | "mixed" | "none" {
  if (snapshot.version === 1) return "none";
  let bound = false;
  let unbound = false;
  for (const run of snapshotTextLayoutRuns(snapshot)) {
    if (run.text.length === 0) continue;
    if (run.fontResourceId === undefined) unbound = true;
    else bound = true;
  }
  if (bound && unbound) return "mixed";
  return unbound ? "legacy" : bound ? "bound" : "none";
}

/** Visit persisted runs without allocating a flattened copy of the document layout. */
export function* snapshotTextLayoutRuns(snapshot: InkSnapshotV1): Generator<TextLayoutRunV2> {
  for (const element of snapshot.elements) {
    if (element.kind !== "text") continue;
    for (const line of element.layout.lines) yield* line.runs;
  }
}
