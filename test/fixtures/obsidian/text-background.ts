import { vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import { textBackgroundAttributes } from "../../../src/obsidian/text/editor/text-editor-background";
import type { TextEditorBackgroundBase } from "../../../src/obsidian/text/editor/text-background-measurement";
import { ManualFrameScheduler } from "./manual-frame-scheduler";
import { immediateWorkScheduler } from "./immediate-work-scheduler";

export function mountTextBackground() {
  const dom = document.createElement("div");
  dom.style.width = "100px";
  dom.style.height = "62.375px";
  const line = document.createElement("div");
  line.className = "cm-line";
  line.style.lineHeight = "62.4px";
  const first = document.createTextNode("aa"),
    last = document.createTextNode("cccc");
  const word = document.createElement("span");
  word.textContent = "Bbbb";
  word.style.lineHeight = "62.4px";
  for (const [name, value] of Object.entries(textBackgroundAttributes({ backgroundOpacity: 0.2 })))
    word.setAttribute(name, value);
  line.append(first, word, last);
  dom.append(line);
  document.body.append(dom);
  const positions = new Map<Node, number>([
    [first, 0],
    [word.firstChild!, 2],
    [last, 6],
  ]);
  vi.spyOn(dom, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 62.375));
  const targetReads = vi
    .spyOn(word, "getClientRects")
    .mockReturnValue([new DOMRect(20, 4.6875, 40, 53)] as unknown as DOMRectList);
  const collapsedReads = vi
    .spyOn(Range.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Range) {
      return new DOMRect(
        (positions.get(this.startContainer)! + this.startOffset) * 10,
        4.6875,
        0,
        53,
      );
    });
  const rangeReads = vi.spyOn(Range.prototype, "getClientRects").mockImplementation(function (
    this: Range,
  ) {
    return [
      new DOMRect(
        (positions.get(this.startContainer)! + this.startOffset) * 10,
        4.6875,
        (this.endOffset - this.startOffset) * 10,
        53,
      ),
    ] as unknown as DOMRectList;
  });
  const measures: { read: () => unknown; write: (value: unknown) => void }[] = [];
  const requestMeasure = vi.fn((request: (typeof measures)[number]) => measures.push(request));
  const view = {
    dom,
    scaleX: 1,
    scaleY: 1,
    visibleRanges: [{ from: 0, to: 10 }],
    posAtDOM: (node: Node) => positions.get(node)!,
    requestMeasure,
  } as unknown as EditorView;
  const frames = new ManualFrameScheduler();
  const scheduler = {
    ...immediateWorkScheduler(),
    requestFrame: frames.requestFrame.bind(frames),
    cancelFrame: frames.cancelFrame.bind(frames),
  };
  const base: TextEditorBackgroundBase = {
    color: { type: "rgba", value: "#FF0000FF" },
    opacity: 0.7,
    width: 100,
    height: 62.375,
  };
  const flush = () => {
    while (frames.pendingCount) frames.runNext();
    while (measures.length) {
      const m = measures.shift()!;
      m.write(m.read());
    }
  };
  return {
    view,
    dom,
    word,
    base,
    frames,
    scheduler,
    measures,
    flush,
    requestMeasure,
    targetReads,
    collapsedReads,
    positions,
    last,
    rangeReads,
  };
}
