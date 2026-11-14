import type {
  TextElementV2,
  TextStyleV2,
  TextRangeStyleV2,
  TextLayoutRunV2,
  TextTableLayoutV2,
} from "../../../domain/schema/public";

export function canonicalTextStyle(style: TextStyleV2): TextStyleV2 {
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    color:
      style.color.type === "theme-text"
        ? { type: "theme-text" }
        : { type: "rgba", value: style.color.value },
    opacity: style.opacity,
    bold: style.bold,
    italic: style.italic,
    underline: style.underline,
    strikethrough: style.strikethrough,
  };
}

export function canonicalTextElement(element: TextElementV2): TextElementV2 {
  const steps = canonicalTextElementSteps(element);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

export function* canonicalTextElementSteps(
  element: TextElementV2,
  signal?: AbortSignal,
): Generator<void, TextElementV2> {
  signal?.throwIfAborted();
  const canonical: TextElementV2 = {
    kind: "text",
    id: element.id,
    createdAt: element.createdAt,
    rotation: element.rotation,
    pivot: { x: element.pivot.x, y: element.pivot.y },
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    source: element.source,
    style: canonicalTextStyle(element.style),
    ranges: [],
    paragraphs: [],
    backgroundColor:
      element.backgroundColor === null
        ? null
        : element.backgroundColor.type === "theme-text"
          ? { type: "theme-text" }
          : { type: "rgba", value: element.backgroundColor.value },
    backgroundOpacity: element.backgroundOpacity,
    layout: canonicalTextLayoutHeader(element.layout),
  };
  for (const range of element.ranges) {
    canonical.ranges.push({
      start: range.start,
      end: range.end,
      style: canonicalPartialStyle(range.style),
    });
    yield;
    signal?.throwIfAborted();
  }
  for (const paragraph of element.paragraphs) {
    canonical.paragraphs.push({ start: paragraph.start, alignment: paragraph.alignment });
    yield;
    signal?.throwIfAborted();
  }
  for (const line of element.layout.lines) {
    const runs: typeof line.runs = [];
    for (const run of line.runs) {
      runs.push(canonicalTextRun(run));
      yield;
      signal?.throwIfAborted();
    }
    canonical.layout.lines.push({
      x: line.x,
      y: line.y,
      width: line.width,
      height: line.height,
      baseline: line.baseline,
      runs,
    });
    yield;
    signal?.throwIfAborted();
  }
  for (const math of element.layout.math ?? []) {
    const paths: typeof math.paths = [];
    for (const path of math.paths) {
      paths.push({
        d: path.d,
        ...(path.fillRule === undefined ? {} : { fillRule: path.fillRule }),
      });
      yield;
      signal?.throwIfAborted();
    }
    canonical.layout.math!.push({
      start: math.start,
      end: math.end,
      display: math.display,
      x: math.x,
      y: math.y,
      width: math.width,
      height: math.height,
      paths,
    });
    yield;
    signal?.throwIfAborted();
  }
  for (const table of element.layout.tables ?? [])
    canonical.layout.tables!.push(yield* canonicalTextTableSteps(table, signal));
  return canonical;
}

function* canonicalTextTableSteps(
  table: TextTableLayoutV2,
  signal?: AbortSignal,
): Generator<void, TextTableLayoutV2> {
  const rowHeights: number[] = [];
  for (const height of table.rowHeights) {
    rowHeights.push(height);
    yield;
    signal?.throwIfAborted();
  }
  return {
    start: table.start,
    end: table.end,
    x: table.x,
    y: table.y,
    width: table.width,
    height: table.height,
    columns: table.columns,
    rowHeights,
    borderWidth: table.borderWidth,
  };
}

function canonicalTextLayoutHeader(layout: TextElementV2["layout"]): TextElementV2["layout"] {
  return {
    version: 1,
    ...(layout.padding === undefined ? {} : { padding: layout.padding }),
    ...(layout.baseFontResourceId === undefined
      ? {}
      : { baseFontResourceId: layout.baseFontResourceId }),
    lines: [],
    ...(layout.math === undefined ? {} : { math: [] }),
    ...(layout.tables === undefined ? {} : { tables: [] }),
  };
}

function canonicalTextRun(run: TextLayoutRunV2): TextLayoutRunV2 {
  return {
    text: run.text,
    start: run.start,
    end: run.end,
    x: run.x,
    width: run.width,
    ...(run.fontResourceId === undefined ? {} : { fontResourceId: run.fontResourceId }),
    ...(run.style === undefined ? {} : { style: canonicalPartialStyle(run.style) }),
  };
}

function canonicalPartialStyle(style: TextRangeStyleV2): TextRangeStyleV2 {
  const result: TextRangeStyleV2 = {};
  for (const key of [
    "fontFamily",
    "fontSize",
    "color",
    "opacity",
    "bold",
    "italic",
    "underline",
    "strikethrough",
    "backgroundColor",
    "backgroundOpacity",
  ] as const) {
    if (style[key] !== undefined) Object.assign(result, { [key]: style[key] });
  }
  if (style.color !== undefined)
    result.color =
      style.color.type === "theme-text"
        ? { type: "theme-text" }
        : { type: "rgba", value: style.color.value };
  if (style.backgroundColor !== undefined)
    result.backgroundColor =
      style.backgroundColor === null
        ? null
        : style.backgroundColor.type === "theme-text"
          ? { type: "theme-text" }
          : { type: "rgba", value: style.backgroundColor.value };
  return result;
}
