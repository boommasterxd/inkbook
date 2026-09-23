import { describe, expect, it } from "vitest";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { createMountedElement } from "../../../../src/rendering/scene/mounted-element";
import { SceneElementFades } from "../../../../src/rendering/scene/scene-element-fades";
import { FakeDocument, fakeNode, fakeRectangleRecord } from "./fakes";

function setup(count: number, parts = 1) {
  const owner = new FakeDocument() as unknown as Document;
  const entries = Array.from({ length: count }, (_, index) => {
    const id = `fade-${String(index)}`;
    return createMountedElement(
      owner,
      fakeRectangleRecord(id, 0, 0),
      Array.from({ length: parts }, () => ({ d: "M0 0L10 10", paint: "stroke" as const })),
      createInstrumentation(),
    );
  });
  const ids = entries.map((entry) => entry.id);
  const mounted = new Map(entries.map((entry) => [entry.id, entry]));
  return { entries, ids, mounted, fades: new SceneElementFades(mounted) };
}

it("shares the initial deadline across calls and timestamps real transition starts", () => {
  const { ids, entries, fades } = setup(4, 2);
  let time = 0;
  let writes = 0;
  for (const entry of entries) {
    for (const path of entry.paths) {
      Object.defineProperty(fakeNode(path.node).style, "filter", {
        set: () => {
          time += 5;
          writes += 1;
        },
      });
    }
  }
  const now = () => time;
  fades.set(ids.slice(0, 2), 300, { deadline: 6, now });
  expect(writes).toBe(2);
  expect(fades.isExitReady(ids[0]!, 309)).toBe(false);
  expect(fades.isExitReady(ids[0]!, 310)).toBe(true);
  fades.set(ids.slice(2), 300, { deadline: time + 100, now });
  expect(writes).toBe(2);
  fades.flush(time + 6, now);
  expect(writes).toBe(4);
  fades.set(ids, null);
  expect(fades.pending).toBe(false);
});

describe("bounded element fades", () => {
  it("keeps queued removals visible until each transition can finish", () => {
    const { entries, ids, fades } = setup(2000);
    fades.set(ids, 160, { deadline: 10 + 8, now: () => 10 });
    expect(entries.filter((entry) => entry.fadeActive)).toHaveLength(128);
    expect(fades.isExitReady(ids[0]!, 169)).toBe(false);
    expect(fades.isExitReady(ids[0]!, 170)).toBe(true);
    expect(fades.isExitReady(ids[1999]!, 1000)).toBe(false);
    let time = 10;
    while (fades.pending) {
      time += 8;
      fades.flush(Infinity, () => time);
    }
    expect(
      entries.every((entry) => fakeNode(entry.paths[0]!.node).style.filter === "blur(12.5px)"),
    ).toBe(true);
    expect(fades.isExitReady(ids[1999]!, time + 159)).toBe(false);
    expect(fades.isExitReady(ids[1999]!, time + 160)).toBe(true);
  });

  it("shares initial capacity across calls and resumes multipart nodes", () => {
    const { entries, ids, fades } = setup(2, 100);
    fades.set([ids[0]!], 160, { deadline: 0 + 8, now: () => 0 });
    fades.set([ids[1]!], 160, { deadline: 0 + 8, now: () => 0 });
    const faded = () =>
      entries
        .flatMap((entry) => entry.paths)
        .filter((path) => Boolean(fakeNode(path.node).style.animation)).length;
    expect(faded()).toBe(128);
    expect(fades.isExitReady(ids[1]!, 200)).toBe(false);
    expect(fades.flush(Infinity, () => 190)).toBe(true);
    expect(faded()).toBe(128);
    expect(fades.flush(Infinity, () => 200)).toBe(false);
    expect(faded()).toBe(200);
    expect(fades.isExitReady(ids[1]!, 359)).toBe(false);
    expect(fades.isExitReady(ids[1]!, 360)).toBe(true);
  });

  it("makes minimum progress at an expired deadline without exceeding it further", () => {
    const { ids, entries, fades } = setup(130);
    fades.set(ids, 0, { deadline: 0 + 8, now: () => 0 });
    expect(fades.flush(0, () => 0)).toBe(true);
    expect(entries.filter((entry) => entry.fadeActive)).toHaveLength(128);
    expect(fades.flush(0, () => 10)).toBe(true);
    expect(entries.filter((entry) => entry.fadeActive)).toHaveLength(129);
    expect(fades.isExitReady(ids[128]!, 10)).toBe(true);
    expect(fades.flush(0, () => 10)).toBe(false);
  });

  it("cancels pending, partially written and completed fades before reuse", () => {
    const { ids, entries, fades } = setup(3, 100);
    fades.set(ids, 160, { deadline: 0 + 8, now: () => 0 });
    fades.set(ids, null, { deadline: 20 + 8, now: () => 20 });
    expect(fades.pending).toBe(false);
    expect(entries.every((entry) => !entry.fadeActive)).toBe(true);
    expect(
      entries
        .flatMap((entry) => entry.paths)
        .every((path) => {
          const { animation, filter } = fakeNode(path.node).style;
          return !animation && !filter;
        }),
    ).toBe(true);
    expect(ids.every((id) => fades.isExitReady(id, 20))).toBe(true);
    fades.flush(Infinity, () => 30);
    fades.set([ids[0]!], 50, { deadline: 30 + 8, now: () => 30 });
    expect(fades.isExitReady(ids[0]!, 79)).toBe(false);
    expect(fades.isExitReady(ids[0]!, 80)).toBe(true);
  });

  it("does not overwrite an existing eraser transition with removal feedback", () => {
    const { ids, fades } = setup(129);
    fades.set(ids, 160, { deadline: 0 + 8, now: () => 0 });
    fades.set(ids, 0, { deadline: 10 + 8, now: () => 10 });
    fades.flush(Infinity, () => 10);
    fades.flush(Infinity, () => 20);
    expect(fades.isExitReady(ids[0]!, 159)).toBe(false);
    expect(fades.isExitReady(ids[128]!, 179)).toBe(false);
  });

  it("drops missing mounted entries and releases remaining requests", () => {
    const { ids, mounted, fades } = setup(300);
    fades.set(ids, 160, { deadline: 0 + 8, now: () => 0 });
    mounted.clear();
    expect(fades.flush(Infinity, () => 10)).toBe(true);
    expect(fades.flush(Infinity, () => 20)).toBe(true);
    expect(fades.flush(Infinity, () => 20)).toBe(false);
    fades.release();
    expect(ids.every((id) => fades.isExitReady(id, 0))).toBe(true);
    fades.set(["missing"], 160, { deadline: 0 + 8, now: () => 0 });
    expect(fades.pending).toBe(false);
  });
});
