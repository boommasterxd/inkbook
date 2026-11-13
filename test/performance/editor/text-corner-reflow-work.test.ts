import { expect, it, vi } from "vitest";
import { SelectionHandleSession } from "../../../src/editor/selection/handle-session";
import { oppositeElementHandlePoint } from "../../../src/editor/selection/handles";
import { resolveShapeAnchor } from "../../../src/domain/geometry/anchors";
import type { TextElementV2 } from "../../../src/domain/schema/public";
import { observeSchemaArray } from "../../fixtures/domain/schema-array-work";
import { pausedWorkScheduler } from "../../fixtures/obsidian/immediate-work-scheduler";
import { textElement } from "../../unit/domain/schema/fixtures";

import {
  deferredTextReflow,
  emptyTextSnap,
  scaledHandlePointer,
} from "../../fixtures/editor/text-handle-session";

async function until(condition: () => boolean): Promise<void> {
  for (let step = 0; step < 40 && !condition(); step += 1) await Promise.resolve();
  expect(condition()).toBe(true);
}

function unexpectedReplan(): never {
  throw new Error("A text preview must not replan the store.");
}

function capacityFixture() {
  const original = textElement();
  const lines = observeSchemaArray(
    Array.from({ length: 2000 }, (_, index) => ({
      ...original.layout.lines[0]!,
      y: index * 20,
      runs: [{ text: "a", start: index * 2, end: index * 2 + 1, x: 0, width: 10 }],
    })),
  );
  const ranges = observeSchemaArray(
    Array.from({ length: 2000 }, (_, index) => ({
      start: index * 2,
      end: index * 2 + 1,
      style: { fontSize: 20 },
    })),
  );
  const paths = observeSchemaArray([{ d: "M0 0L1 1Z" }]);
  const rowHeights = observeSchemaArray([20, 20]);
  const source = `${"a\n".repeat(2000)}$x$\n\n| a |\n|---|\n| b |`;
  const text: TextElementV2 = {
    ...original,
    source,
    width: 200,
    style: { ...original.style, fontSize: 20 },
    ranges: ranges.observed,
    height: 40_000,
    pivot: { x: original.x + 100, y: original.y + 20_000 },
    layout: {
      version: 1,
      lines: lines.observed,
      padding: 28,
      baseFontResourceId: "a".repeat(64),
      math: [
        {
          start: 4000,
          end: 4003,
          display: false,
          x: 0,
          y: 0,
          width: 10,
          height: 20,
          paths: paths.observed,
        },
      ],
      tables: [
        {
          start: 4005,
          end: source.length,
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          columns: 1,
          borderWidth: 1,
          rowHeights: rowHeights.observed,
        },
      ],
    },
  };
  const gate = pausedWorkScheduler();
  const { requests, reflow } = deferredTextReflow();
  const anchor = oppositeElementHandlePoint(text, "bottom-right");
  const start = resolveShapeAnchor(text, { kind: "box", position: "bottom-right" })!;
  const ready = vi.fn();
  const session = new SelectionHandleSession({
    action: { kind: "scale", position: "bottom-right", anchor, rotation: 0 },
    elements: [text],
    planner: {
      countReverseDependencies: () => 0,
      planReplacements: unexpectedReplan,
      planReplacementsTimeSliced: async () => unexpectedReplan(),
    },
    startPointer: start,
    onPreviewReady: ready,
    reflowText: reflow,
    snap: emptyTextSnap(gate.scheduler),
  });
  const update = (factor: number) => session.update(scaledHandlePointer(anchor, start, factor));
  const complete = (index: number) => {
    const request = requests[index]!;
    request.resolve({ ...request.element, height: request.element.height + 4 });
  };
  ranges.work.indexedReads = 0;
  return { lines, ranges, paths, rowHeights, gate, requests, ready, session, update, complete };
}

it("admits native reflow source through the central budget without scaling discarded 2000-line geometry", async () => {
  const { lines, ranges, paths, rowHeights, gate, requests, ready, session, update, complete } =
    capacityFixture();
  const checkpoint = vi.spyOn(gate.scheduler, "checkpoint");
  update(1.1);
  await until(() => checkpoint.mock.calls.length === 1);
  for (let sample = 1; sample <= 100; sample += 1) update(1.1 + sample / 1000);
  expect(lines.work.indexedReads).toBe(0);
  expect(requests).toHaveLength(0);
  gate.resume();
  await until(() => requests.length === 1);
  expect(requests[0]!.element.width).toBe(240);
  expect(lines.work.indexedReads).toBe(0);
  expect(ranges.work.indexedReads).toBe(2000);
  expect(requests[0]!.element.layout).toEqual({
    version: 1,
    lines: [],
    padding: 33.6,
    baseFontResourceId: "a".repeat(64),
  });
  expect(requests[0]!.element.style.fontSize).toBe(24);
  expect(requests[0]!.element.ranges[0]!.style.fontSize).toBe(24);
  for (let sample = 1; sample <= 100; sample += 1) update(1.2 + sample / 1000);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(lines.work.indexedReads).toBe(0);
  complete(0);
  await until(() => requests.length === 2);
  expect(requests[1]!.element.width).toBe(260);
  expect(lines.work.indexedReads).toBe(0);
  expect(ranges.work.indexedReads).toBe(4000);
  complete(1);
  await until(() => ready.mock.calls.length === 1);
  const native = session.preview.exactElements[0];
  const result = await session.prepareCommitTimeSliced({
    shouldYield: () => false,
    yieldControl: async () => undefined,
  });
  if (result.status !== "ready") throw new Error("Expected a native text commit.");
  expect(result.replacements[0]).toBe(native);
  expect(requests).toHaveLength(2);
  expect(lines.work.indexedReads).toBe(0);
  update(1.4);
  await until(() => requests.length === 3);
  const preparedReads = ranges.work.indexedReads;
  expect(preparedReads).toBe(6000);
  session.cancel();
  expect(requests[2]!.signal.aborted).toBe(true);
  complete(2);
  await Promise.resolve();
  await Promise.resolve();
  expect(session.preview.exactElements).toEqual([]);
  expect(ready).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(3);
  expect(ranges.work.indexedReads).toBe(preparedReads);
  expect(lines.work.indexedReads).toBe(0);
  expect(paths.work.indexedReads).toBe(0);
  expect(rowHeights.work.indexedReads).toBe(0);
});
