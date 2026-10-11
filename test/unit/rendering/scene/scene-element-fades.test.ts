import { expect, it } from "vitest";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { createMountedElement } from "../../../../src/rendering/scene/mounted-element";
import { SceneElementFades } from "../../../../src/rendering/scene/scene-element-fades";
import { setHistoryFadeGate } from "../../../../src/rendering/scene/element-fade-style";
import { removeVisibilityExits } from "../../../../src/rendering/scene/visibility-publication";
import type { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import type { SceneStorePort } from "../../../../src/rendering/scene/types";
import { createTestStroke } from "../../../fixtures/persistence/worker-snapshot";
import { FakeDocument, fakeNode, fakeRectangleRecord } from "./fakes";

it("retains an interrupted generation until all multipart roots are physically detached", () => {
  const { entry, mounted, document, svg, fades } = setupMembership(130);
  const group = document.createElementNS("", "g");
  for (const path of entry.paths) group.append(fakeNode(path.node));
  fades.setMembership(entry.id, "exit", 400);
  fades.flush(Infinity, () => 0);
  fades.flush(Infinity, () => 0);
  fades.interruptMembership();
  const pending = { exitIds: [entry.id], exitIndex: 0 };
  const remove = () =>
    removeVisibilityExits(
      pending,
      {
        dom: { group: () => group } as unknown as SceneDom,
        instrumentation: createInstrumentation(),
        mounted,
        store: { get: () => undefined } as unknown as SceneStorePort,
        visibility: { contains: () => false, releaseId: () => undefined },
        pathCache: { invalidate: () => undefined, retain: () => undefined },
        isExitReady: (id, now) => fades.isExitReady(id, now),
        exitReadyAt: (id) => fades.readyAt(id),
        onUnmount: (id) => fades.releaseMounted(id),
      },
      {
        deadline: Infinity,
        now: () => 10,
        isExit: () => true,
        publication: { remainingRoots: 384, remainingRemovals: 64 },
      },
    );
  expect(remove()).toBe(false);
  expect(group.nodes).toHaveLength(66);
  expect(svg.style.getPropertyValue("--inkbook-history-duration-0")).toBe("0ms");
  expect(remove()).toBe(false);
  expect(group.nodes).toHaveLength(2);
  expect(svg.style.getPropertyValue("--inkbook-history-duration-0")).toBe("0ms");
  expect(remove()).toBe(true);
  expect(group.nodes).toHaveLength(0);
  expect(svg.style.getPropertyValue("--inkbook-history-duration-0")).toBe("");
  expect(fades.memoryUsage()).toBe(0);
});

it.each([1, 3])(
  "retains concealment ownership when %i published roots are interrupted before their first fade",
  (parts) => {
    const { entry, mounted, svg, fades } = setupMembership(parts);
    mounted.clear();
    fades.setMembership(entry.id, "enter", 400);
    mounted.set(entry.id, entry);
    fades.bindMounted(entry);
    fades.interruptMembership();
    fades.setMembership(entry.id, "exit", 400);
    expect(svg.style.getPropertyValue("--inkbook-history-visibility-0")).toBe("visible");
    fades.flush(0, () => 0);
    expect(svg.style.getPropertyValue("--inkbook-history-visibility-0")).toBe(
      parts === 1 ? "" : "visible",
    );
    fades.flush(Infinity, () => 0);
    expect(svg.style.getPropertyValue("--inkbook-history-visibility-0")).toBe("");
    expect(entry.paths.every((path) => !fakeNode(path.node).style.visibility)).toBe(true);
    expect(
      entry.paths.every((path) =>
        String(fakeNode(path.node).style.animation).includes("opacity-exit"),
      ),
    ).toBe(true);
    fades.releaseMounted(entry.id);
    expect(fades.memoryUsage()).toBe(0);
  },
);

it.each([1, 3])(
  "keeps installed generations through interrupted %i-target retargets and eraser takeover",
  (parts) => {
    const { entry, svg, fades } = setupMembership(parts);
    fades.setMembership(entry.id, "enter", 400);
    fades.flush(Infinity, () => 0);
    fades.interruptMembership();
    fades.setMembership(entry.id, "exit", 400);
    expect(svg.style.getPropertyValue("--inkbook-history-duration-0")).toBe("0ms");
    fades.flush(0, () => 0);
    expect(svg.style.getPropertyValue("--inkbook-history-duration-0")).toBe(
      parts === 1 ? "" : "0ms",
    );
    for (let generation = 1; generation < 10; generation += 1) {
      fades.interruptMembership();
      fades.setMembership(entry.id, "enter", 400);
      expect(svg.style.getPropertyValue(`--inkbook-history-duration-${generation}`)).toBe("0ms");
      fades.flush(0, () => 0);
      expect(svg.style.getPropertyValue(`--inkbook-history-duration-${generation}`)).toBe("");
      expect(fades.memoryUsage()).toBeLessThan(1_000);
    }
    fades.interruptMembership();
    fades.set([entry.id], 400);
    expect(svg.style.getPropertyValue("--inkbook-history-duration-10")).toBe("0ms");
    fades.flush(Infinity, () => 0);
    expect(svg.style.getPropertyValue("--inkbook-history-duration-10")).toBe("");
    expect(svg.style.getPropertyValue("--inkbook-history-duration-0")).toBe("");
    expect(
      entry.paths.every((path) =>
        String(fakeNode(path.node).style.animation).includes("opacity-exit 400ms"),
      ),
    ).toBe(true);
    fades.set([entry.id], null);
    expect(fades.memoryUsage()).toBe(0);
  },
);

function setupMembership(parts: number) {
  const { entries, mounted } = setup(1, parts);
  const document = new FakeDocument();
  const svg = document.createElementNS("", "svg") as unknown as SVGElement;
  const fades = new SceneElementFades(mounted, undefined, (generation, interrupted) =>
    setHistoryFadeGate(svg, generation, interrupted),
  );
  return { entry: entries[0]!, mounted, document, svg, fades };
}

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
      Object.defineProperty(fakeNode(path.node).style, "animation", {
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

it("targets pressure paths and restores queued feedback before reuse", () => {
  const owner = new FakeDocument() as unknown as Document;
  const element = createTestStroke();
  const entries = Array.from({ length: 130 }, (_, rank) => {
    const record = {
      ...fakeRectangleRecord(`pressure-${String(rank)}`, rank, 0),
      element: {
        ...element,
        id: `pressure-${String(rank)}`,
        style: { ...element.style, pressureEnabled: true },
      },
    };
    return createMountedElement(
      owner,
      record,
      [{ d: "M0 0L10 10Z", paint: "fill" }],
      createInstrumentation(),
    );
  });
  const ids = entries.map((entry) => entry.id);
  const fades = new SceneElementFades(new Map(entries.map((entry) => [entry.id, entry])));
  fades.set(ids, 160, { deadline: 8, now: () => 0 });
  expect(entries.filter((entry) => entry.fadeActive)).toHaveLength(128);
  expect(entries.every((entry) => !fakeNode(entry.group!).style.animation)).toBe(true);
  expect(fakeNode(entries[0]!.paths[0]!.node).style.animation).toContain(
    "inkbook-element-fill-exit",
  );
  fades.set(ids, null);
  expect(fades.pending).toBe(false);
  expect(entries.every((entry) => !entry.fadeActive)).toBe(true);
  expect(entries.every((entry) => !fakeNode(entry.paths[0]!.node).style.animation)).toBe(true);
  expect(ids.every((id) => fades.isExitReady(id, 0))).toBe(true);
  fades.flush(Infinity, () => 20);
  fades.set([ids[0]!], 50, { deadline: 28, now: () => 20 });
  expect(fakeNode(entries[0]!.group!).style.animation).toBeUndefined();
  expect(fakeNode(entries[0]!.paths[0]!.node).style.animation).toContain(
    "inkbook-element-fill-exit 50ms",
  );
  expect(fades.isExitReady(ids[0]!, 69)).toBe(false);
  expect(fades.isExitReady(ids[0]!, 70)).toBe(true);
  fades.release();
});

it("holds restoration until publication and reverses exits without paint or transform changes", () => {
  const { entries, mounted, fades } = setup(1);
  const entry = entries[0]!;
  const node = fakeNode(entry.paths[0]!.node);
  mounted.clear();
  fades.setMembership(entry.id, "enter", 400);
  expect(fades.pending).toBe(false);
  mounted.set(entry.id, entry);
  fades.bindMounted(entry);
  expect(node.style.visibility).toContain(", hidden)");
  fades.flush(Infinity, () => 10);
  expect(node.style.visibility).toBeUndefined();
  expect(node.style.animation).toContain("inkbook-element-opacity-enter");
  expect(node.style.animation).toContain("400ms)");
  expect(node.style.animation).toContain("reverse both");
  expect(node.style.filter || "").toBe("");
  expect(node.style.transform || "").toBe("");
  fades.setMembership(entry.id, "exit", 400);
  fades.flush(Infinity, () => 20);
  expect(node.style.animation).toContain("inkbook-element-opacity-exit");
  expect(node.style.animation).toContain("400ms)");
  expect(fades.isExitReady(entry.id, 419)).toBe(false);
  expect(fades.isExitReady(entry.id, 420)).toBe(true);
  fades.setMembership(entry.id, "enter", 400);
  fades.flush(Infinity, () => 30);
  fades.flush(Infinity, () => 429);
  expect(fades.pending).toBe(true);
  fades.flush(Infinity, () => 430);
  expect(fades.pending).toBe(false);
  expect(node.style.animation).toBe("");
  expect(node.style.getPropertyValue("opacity")).toBe("");
  expect(entry.fadeActive).toBe(false);
});

it("cancels unpublished restoration and prunes only settled offscreen requests within the deadline", () => {
  const { entries, mounted, fades } = setup(3);
  mounted.clear();
  for (const entry of entries) fades.setMembership(entry.id, "enter", 400);
  fades.setMembership(entries[0]!.id, "exit", 400);
  let time = 0;
  const visited: string[] = [];
  fades.settleVisibility((id) => {
    visited.push(id);
    time += 5;
    return id === entries[1]!.id;
  });
  fades.flush(1, () => time);
  expect(visited).toEqual([entries[1]!.id]);
  expect(fades.pending).toBe(true);
  fades.flush(Infinity, () => time);
  expect(visited).toEqual([entries[1]!.id, entries[2]!.id]);
  for (const entry of entries) {
    mounted.set(entry.id, entry);
    fades.bindMounted(entry);
  }
  expect(entries.map((entry) => fakeNode(entry.paths[0]!.node).style.visibility)).toEqual([
    undefined,
    "var(--inkbook-history-visibility-0, hidden)",
    undefined,
  ]);
  fades.release();
  expect(fades.pending).toBe(false);
});

it("lets eraser feedback own a running history entrance until its full exit completes", () => {
  const { entries, fades } = setup(1);
  const entry = entries[0]!;
  fades.setMembership(entry.id, "enter", 400);
  fades.flush(Infinity, () => 0);
  fades.set([entry.id], 400, { deadline: Infinity, now: () => 200 });
  fades.flush(Infinity, () => 400);
  expect(fakeNode(entry.paths[0]!.node).style.animation).toContain("opacity-exit 400ms");
  expect(fades.isExitReady(entry.id, 599)).toBe(false);
  expect(fades.isExitReady(entry.id, 600)).toBe(true);
});

it.each([1, 2])(
  "restores %i pressure paths through their original paint and group alpha",
  (parts) => {
    const { mounted, fades } = setup(0);
    const owner = new FakeDocument() as unknown as Document;
    const stroke = createTestStroke();
    const record = {
      ...fakeRectangleRecord("pressure-restore", 0, 0),
      element: {
        ...stroke,
        id: "pressure-restore",
        style: { ...stroke.style, opacity: 0.35, pressureEnabled: true },
      },
    };
    const entry = createMountedElement(
      owner,
      record,
      Array.from({ length: parts }, () => ({ d: "M0 0L10 10Z", paint: "fill" as const })),
      createInstrumentation(),
    );
    fades.setMembership(entry.id, "enter", 400);
    mounted.set(entry.id, entry);
    fades.bindMounted(entry);
    const group = fakeNode(entry.group!);
    expect(group.attributes.get("opacity")).toBe("0.35");
    expect(group.style.visibility).toContain(", hidden)");
    fades.flush(Infinity, () => 0);
    const target = parts === 1 ? fakeNode(entry.paths[0]!.node) : group;
    expect(target.style.animation).toContain(parts === 1 ? "fill-enter" : "opacity-enter");
    expect(group.attributes.get("opacity")).toBe("0.35");
    expect(entry.paths.every((path) => !fakeNode(path.node).style.opacity)).toBe(true);
    fades.flush(Infinity, () => 400);
    expect(fades.memoryUsage()).toBe(0);
    expect(target.style.animation).toBe("");
    expect(group.attributes.get("opacity")).toBe("0.35");
  },
);

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
    entries.every((entry) =>
      fakeNode(entry.paths[0]!.node)
        .style.getPropertyValue("animation")
        .startsWith("inkbook-element-opacity-exit"),
    ),
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
