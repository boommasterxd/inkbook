import { describe, expect, it } from "vitest";
import {
  convertObsidianInk,
  ObsidianInkImportError,
} from "../../../../../src/persistence/import/obsidian-ink/convert";
import {
  canvasSnapshot,
  canvasStroke,
  canvasStyle,
  inkSvg,
  tldrawShape,
  tldrawSnapshot,
} from "./fixtures";

const options = () => ({
  timestamp: 100,
  signal: new AbortController().signal,
  checkpoint: () => undefined,
});

describe("Obsidian Ink source validation", () => {
  it.each([
    "<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><svg/>",
    '<svg><metadata><ink file-type="inkWriting"/><ink-canvas>{}</ink-canvas></metadata></svg><svg/>',
    "<svg><script>alert(1)</script><metadata/></svg>",
    inkSvg(canvasSnapshot()).replace('file-type="inkWriting"', 'file-type="inkDrawing"'),
    inkSvg(canvasSnapshot()).replace("</metadata>", "<ink-canvas>{}</ink-canvas></metadata>"),
    inkSvg(canvasSnapshot()).replace("</svg>", "</g>"),
    inkSvg(canvasSnapshot()).replace('<ink-canvas version="1">', '<ink-canvas version="2.0.0">'),
    '<svg><metadata><ink file-type="inkWriting"/><ink-canvas>&external;</ink-canvas></metadata></svg>',
    '<svg><metadata><ink file-type="inkWriting"/><ink-canvas>{"version":1,"version":2}</ink-canvas></metadata></svg>',
  ])(
    "rejects hostile, ambiguous or non-writing XML/JSON without creating a partial document",
    async (source) => {
      await expect(convertObsidianInk(source, options())).rejects.toBeInstanceOf(
        ObsidianInkImportError,
      );
    },
  );

  it("reads legacy escaped transcript attributes and single-quoted metadata safely", async () => {
    const source = inkSvg(canvasSnapshot()).replace(
      '<ink file-type="inkWriting"/>',
      "<ink file-type='inkWriting' transcript='a &amp; b &quot;quoted&quot;'/>",
    );
    const result = await convertObsidianInk(source, options());
    expect(result.transcript).toBe('a & b "quoted"');
  });

  it.each([
    { version: 4 },
    { strokes: [{ ...canvasStroke(), points: [] }] },
    {
      version: 3,
      strokeStyles: [canvasStyle],
      strokes: [{ id: "bad", style: 2, points: [0, 0, 500] }],
    },
    { version: 3, strokeStyles: [canvasStyle], strokes: [{ id: "bad", style: 0, points: [0, 0] }] },
    {
      version: 3,
      strokeStyles: [canvasStyle],
      strokes: [{ id: "bad", style: 0, points: [0, 0, 1001] }],
    },
    {
      version: 3,
      strokeStyles: [canvasStyle],
      strokes: [{ id: "bad", style: 0, points: [0, 0, 500], extra: { points: [[9, 9, 1]] } }],
    },
    {
      strokes: [
        { ...canvasStroke(), style: { ...canvasStyle, color: "url(https://example.org/paint)" } },
      ],
    },
    { strokes: [canvasStroke(), canvasStroke()] },
    { elementOrder: ["missing"] },
    { shapes: [{ id: "unsupported", kind: "shape", shapeType: "text", style: {} }] },
  ])("rejects unsupported or damaged editable snapshots: %j", async (overrides) => {
    await expect(
      convertObsidianInk(inkSvg(canvasSnapshot(overrides)), options()),
    ).rejects.toBeInstanceOf(ObsidianInkImportError);
  });

  it("rejects an entire legacy page containing text rather than silently dropping a record", async () => {
    const source = tldrawSnapshot([
      tldrawShape("shape:draw"),
      tldrawShape("shape:text", "text", { text: "do not lose me" }),
    ]);
    await expect(convertObsidianInk(inkSvg(source, "tldraw"), options())).rejects.toMatchObject({
      code: "unsupported-content",
    });
  });
});

describe("Obsidian Ink capacity and cancellation", () => {
  it("rejects missing editable data, excessive nesting and native geometry capacity violations", async () => {
    await expect(
      convertObsidianInk("{}", { ...options(), legacyWriting: true }),
    ).rejects.toBeInstanceOf(ObsidianInkImportError);
    const deep = `${"[".repeat(33)}0${"]".repeat(33)}`;
    await expect(
      convertObsidianInk(deep, { ...options(), legacyWriting: true }),
    ).rejects.toBeInstanceOf(ObsidianInkImportError);
    const outside = canvasStroke();
    outside.offset.x = 2_000_000;
    await expect(
      convertObsidianInk(inkSvg(canvasSnapshot({ strokes: [outside] })), options()),
    ).rejects.toBeInstanceOf(ObsidianInkImportError);
  });

  it("honors cancellation before parsing and while central admission is suspended", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancel import"));
    await expect(
      convertObsidianInk(inkSvg(canvasSnapshot()), { ...options(), signal: controller.signal }),
    ).rejects.toThrow("cancel import");
    const next = new AbortController();
    let release: (() => void) | undefined;
    const pending = convertObsidianInk(inkSvg(canvasSnapshot()), {
      ...options(),
      signal: next.signal,
      checkpoint: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    await Promise.resolve();
    next.abort(new Error("cancel suspended import"));
    release?.();
    await expect(pending).rejects.toThrow("cancel suspended import");
  });
});
