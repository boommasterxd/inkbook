import { describe, expect, it, vi } from "vitest";
import { SelectionHandleSession } from "../../../../src/editor/selection/handle-session";
import type { SelectionHandlePreview } from "../../../../src/editor/selection/handle-types";
import {
  oppositeBoxAnchor,
  oppositeElementHandlePoint,
} from "../../../../src/editor/selection/handles";
import { resolveShapeAnchor } from "../../../../src/domain/geometry/anchors";
import { pointDistance } from "../../../../src/domain/geometry/public";
import type { BoxAnchorV1, TextElementV2 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import { textElement } from "../../domain/schema/fixtures";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

import {
  deferredTextReflow,
  emptyTextSnap,
  scaledHandlePointer,
} from "../../../fixtures/editor/text-handle-session";

const scheduler = { shouldYield: () => false, yieldControl: async () => undefined };

function fixture(rotation = 0, position: BoxAnchorV1 = "bottom-right") {
  const text = { ...textElement(), rotation };
  const anchor = oppositeElementHandlePoint(text, position);
  const start = resolveShapeAnchor(text, { kind: "box", position })!;
  const { requests, reflow } = deferredTextReflow();
  const ready = vi.fn<(preview: SelectionHandlePreview) => void>();
  const session = new SelectionHandleSession({
    action: { kind: "scale", position, anchor, rotation },
    elements: [text],
    startPointer: start,
    planner: new ElementStore([text]),
    onPreviewReady: ready,
    reflowText: reflow,
    snap: emptyTextSnap(immediateWorkScheduler()),
  });
  const pointer = (factor: number) => scaledHandlePointer(anchor, start, factor);
  const complete = (index: number) => {
    const request = requests[index]!;
    request.resolve({ ...request.element, height: request.element.height + 4 });
  };
  return { text, anchor, start, session, requests, ready, pointer, complete };
}

async function until(condition: () => boolean): Promise<void> {
  for (let step = 0; step < 30 && !condition(); step += 1) await Promise.resolve();
  expect(condition()).toBe(true);
}

describe("live native text corner layout", () => {
  it.each([0, 30, 90])(
    "publishes complete native metrics before release and reuses them at %s degrees",
    async (rotation) => {
      for (const position of ["top-left", "top-right", "bottom-left", "bottom-right"] as const) {
        const { session, anchor, requests, ready, pointer, complete } = fixture(rotation, position);
        const affine = session.update(pointer(1.5));
        expect(affine.transform?.kind).toBe("scale");
        expect(affine.exactElements[0]).toBe(affine.textScaleBasis);
        expect(requests).toHaveLength(0);
        await until(() => requests.length === 1);
        complete(0);
        await until(() => ready.mock.calls.length === 1);
        const preview = session.preview;
        expect(preview.transform).toMatchObject({ kind: "scale", factors: { x: 1, y: 1 } });
        const text = preview.exactElements[0] as TextElementV2;
        expect(text).toMatchObject({ width: 150, height: 79, style: { fontSize: 24.75 } });
        const opposite = resolveShapeAnchor(text, {
          kind: "box",
          position: oppositeBoxAnchor(position),
        })!;
        expect(pointDistance(opposite, anchor)).toBeLessThanOrEqual(0.003);
        const commit = await session.prepareCommitTimeSliced(scheduler);
        if (commit.status !== "ready") throw new Error("Expected native text commit.");
        expect(commit.replacements[0]).toBe(text);
        expect(requests).toHaveLength(1);
        session.cancel();
      }
    },
  );

  it("coalesces rapid retargeting and retains the last complete native preview while pending", async () => {
    const { session, requests, ready, pointer, complete } = fixture();
    session.update(pointer(1.2));
    await until(() => requests.length === 1);
    session.update(pointer(1.3));
    session.update(pointer(1.4));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal.aborted).toBe(true);
    complete(0);
    await until(() => requests.length === 2);
    expect(requests[1]!.element.width).toBe(140);
    complete(1);
    await until(() => ready.mock.calls.length === 1);
    const settled = session.preview.exactElements[0];
    const pending = session.update(pointer(1.6));
    expect(pending.transform).toMatchObject({
      kind: "scale",
      factors: { x: 1.6 / 1.4, y: 1.6 / 1.4 },
    });
    expect(pending.exactElements[0]).toBe(settled);
    expect(pending.textScaleBasis).toBe(settled);
    const projected = session.createScalePreviewMaterializer()!(settled!);
    expect(projected).toMatchObject({ kind: "text", width: 160 });
    await until(() => requests.length === 3);
    const committing = session.prepareCommitTimeSliced(scheduler);
    complete(2);
    const result = await committing;
    if (result.status !== "ready") throw new Error("Expected latest native text commit.");
    expect(result.replacements[0]).toBe(session.preview.exactElements[0]);
    expect(result.replacements[0]).toMatchObject({ width: 160, height: 84 });
    expect(requests).toHaveLength(3);
    session.cancel();
  });
});

it("abandons native corner work on reversal and cancellation without late publication", async () => {
  const { session, start, requests, ready, pointer, complete } = fixture();
  session.update(pointer(1.2));
  await until(() => requests.length === 1);
  session.update(start);
  expect(requests[0]!.signal.aborted).toBe(true);
  expect(session.preview.exactElements).toEqual([]);
  expect(session.prepareCommit()).toEqual({ status: "noop" });
  complete(0);
  session.update(pointer(1.4));
  await until(() => requests.length === 2);
  session.cancel();
  expect(requests[1]!.signal.aborted).toBe(true);
  complete(1);
  await until(() => requests[1]!.signal.aborted);
  await Promise.resolve();
  expect(session.preview.exactElements).toEqual([]);
  expect(ready).not.toHaveBeenCalled();
  expect(requests).toHaveLength(2);
});
