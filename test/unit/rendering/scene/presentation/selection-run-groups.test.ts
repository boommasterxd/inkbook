import { expect, it } from "vitest";
import type { RenderBand } from "../../../../../src/domain/commands/render-bands";
import { buildElementPathParts } from "../../../../../src/domain/geometry/element-path";
import {
  createMountedElement,
  firstPath,
} from "../../../../../src/rendering/scene/content/mounted-element";
import { createInstrumentation } from "../../../../../src/rendering/scene/instrumentation";
import { SelectionRunGroups } from "../../../../../src/rendering/scene/presentation/selection-run-groups";
import { FakeDocument, FakeNode, fakeNode, fakeRectangleRecord } from "../fakes";

function fixture() {
  const document = new FakeDocument();
  const bands = {
    content: new FakeNode(document, "g"),
    highlight: new FakeNode(document, "g"),
  };
  const instrumentation = createInstrumentation();
  const groups = new SelectionRunGroups({
    dom: {
      ownerDocument: document as never,
      group: (band) => bands[band] as never,
    },
    instrumentation,
  });
  function entry(id: string, rank: number, count = 1, band: RenderBand = "content") {
    const record = { ...fakeRectangleRecord(id, rank, rank * 10), band };
    const parts = buildElementPathParts(record.element);
    const mounted = createMountedElement(
      document as never,
      record,
      Array.from({ length: count }, () => parts[0]!),
      instrumentation,
    );
    for (const path of mounted.paths) {
      fakeNode(path.node).setAttribute("data-id", id);
      bands[band].append(fakeNode(path.node));
    }
    return mounted;
  }
  const run = (entries: ReturnType<typeof entry>[]) => ({
    band: entries[0]!.band,
    entries,
    firstRank: entries[0]!.rank,
    lastRank: entries[entries.length - 1]!.rank,
  });
  const flattened = (node: FakeNode): string[] =>
    node.nodes.flatMap((child) => child.getAttribute("data-id") ?? flattened(child));
  return { document, bands, instrumentation, groups, entry, run, flattened };
}

function beginPair(f: ReturnType<typeof fixture>) {
  const a = f.entry("a", 0),
    b = f.entry("b", 1);
  f.groups.begin([f.run([a, b])]);
  return { a, b };
}

it("retains a rejected preparation member and resumes without skipping it", () => {
  const f = fixture();
  const { a } = beginPair(f);
  const attempted: string[] = [];
  let allow = false;
  const prepare = (entry: typeof a) => {
    attempted.push(entry.id);
    return allow;
  };
  expect(f.groups.prepare(10, () => 0, { remainingRoots: 2 }, prepare)).toBe(false);
  expect(firstPath(a).parentNode).toBe(f.bands.content);
  expect(f.groups.parentFor(a)).toBe(f.bands.content);
  expect(f.instrumentation.domReorders).toBe(0);
  expect(f.groups.ready).toBe(false);
  allow = true;
  expect(f.groups.prepare(10, () => 0, { remainingRoots: 0 }, prepare)).toBe(true);
  expect(attempted).toEqual(["a", "a", "b"]);
  expect(f.flattened(f.bands.content)).toEqual(["a", "b"]);
});

it("discards detached wrappers and ownership without visiting or reparenting members", () => {
  const f = fixture();
  const { a, b } = beginPair(f);
  let prepared = 0;
  f.groups.prepare(
    10,
    () => 0,
    { remainingRoots: 2 },
    () => {
      prepared += 1;
    },
  );
  f.groups.publish("translate(10 20)");
  f.groups.beginCommit();
  const parent = f.groups.parentFor(a);
  const reorders = f.instrumentation.domReorders;
  f.groups.discard();
  expect(f.groups.memoryUsage()).toBe(128);
  expect(f.groups.ready).toBe(false);
  expect(f.groups.pendingCanonical).toBeUndefined();
  expect(parent.parentNode).toBeNull();
  expect(firstPath(a).parentNode).toBe(parent);
  expect(firstPath(b).parentNode).toBe(parent);
  expect(f.instrumentation.domReorders).toBe(reorders);
  expect(prepared).toBe(2);
  f.groups.discard();
});

it("preserves global paint order through preparation, frozen suffix normalization and reuse", () => {
  const f = fixture();
  const before = f.entry("before", 0),
    a = f.entry("a", 1),
    b = f.entry("b", 2),
    after = f.entry("after", 3);
  const original = f.flattened(f.bands.content);
  f.groups.begin([f.run([a, b])]);
  expect(f.bands.content.nodes).toHaveLength(4);
  expect(f.groups.ready).toBe(false);
  const prepared: string[] = [];
  const budget = { remainingRoots: 2 };
  expect(
    f.groups.prepare(
      10,
      () => 0,
      budget,
      (e) => prepared.push(e.id),
    ),
  ).toBe(true);
  expect(prepared).toEqual(["a", "b"]);
  expect(budget.remainingRoots).toBe(0);
  expect(f.flattened(f.bands.content)).toEqual(original);
  const prefix = f.bands.content.nodes[1]!,
    suffix = f.bands.content.nodes[2]!;
  const writes = f.instrumentation.contentGeometryWrites;
  f.groups.publish("translate(30 40)");
  f.groups.publish("translate(30 40)");
  expect(f.instrumentation.contentGeometryWrites - writes).toBe(1);
  expect(suffix.getAttribute("transform")).toBe("translate(30 40)");
  f.groups.beginCommit();
  expect(f.groups.next()).toBe(a);
  f.groups.canonical(a);
  expect(prefix.nodes).toEqual([fakeNode(firstPath(a))]);
  expect(suffix.nodes).toEqual([fakeNode(firstPath(b))]);
  expect(suffix.getAttribute("transform")).toBe("translate(30 40)");
  expect(f.flattened(f.bands.content)).toEqual(original);
  expect(f.groups.placement(before, a)).toEqual({
    parent: f.bands.content,
    before: prefix,
  });
  expect(f.groups.placement(a, b)).toEqual({ parent: prefix, before: null });
  expect(f.groups.placement(b, after)).toEqual({
    parent: suffix,
    before: null,
  });
  f.groups.canonical(b);
  f.groups.finishCommit();
  expect(f.groups.ready).toBe(true);
  expect(
    f.groups.prepare(
      10,
      () => 0,
      { remainingRoots: 0 },
      () => {
        throw Error("duplicate preparation");
      },
    ),
  ).toBe(true);
  expect(
    f.groups.prepare(
      10,
      () => 0,
      { remainingRoots: 1 },
      () => {
        throw Error("duplicate preparation");
      },
    ),
  ).toBe(true);
  expect(f.groups.parentFor(a)).toBe(prefix);
  expect(f.flattened(f.bands.content)).toEqual(original);
  f.groups.publish(null);
  expect(
    f.groups.cleanup(
      10,
      () => 0,
      () => undefined,
    ),
  ).toBe(true);
  expect(f.bands.content.nodes).toEqual([before, a, b, after].map((e) => fakeNode(firstPath(e))));
});

it("distinguishes root publication admission from member deadline work and cancels partial preparation", () => {
  const f = fixture();
  const a = f.entry("a", 0),
    b = f.entry("b", 1),
    c = f.entry("c", 2);
  f.groups.begin([f.run([a, b, c])]);
  const prepared: string[] = [];
  expect(
    f.groups.prepare(
      1,
      () => 1,
      { remainingRoots: 2 },
      () => undefined,
    ),
  ).toBe(false);
  expect(f.bands.content.nodes).toHaveLength(3);
  expect(
    f.groups.prepare(
      10,
      () => 0,
      { remainingRoots: 1 },
      () => undefined,
    ),
  ).toBe(false);
  expect(f.instrumentation.domRootsPublished).toBe(1);
  let time = 0;
  const budget = { remainingRoots: 1 };
  expect(
    f.groups.prepare(
      1,
      () => time,
      budget,
      (e) => {
        prepared.push(e.id);
        time += 1;
      },
    ),
  ).toBe(false);
  expect(prepared).toEqual(["a"]);
  expect(f.flattened(f.bands.content)).toEqual(["a", "b", "c"]);
  expect(f.groups.ready).toBe(false);
  const released: string[] = [];
  expect(
    f.groups.cleanup(
      1,
      () => 1,
      (e) => released.push(e.id),
    ),
  ).toBe(false);
  expect(
    f.groups.cleanup(
      1,
      () => 0,
      (e) => released.push(e.id),
    ),
  ).toBe(true);
  expect(released).toEqual(["a"]);
  expect(f.bands.content.nodes).toEqual([a, b, c].map((e) => fakeNode(firstPath(e))));
  expect(f.groups.memoryUsage()).toBe(128);
  f.groups.begin([f.run([a, b, c])]);
  const noMoreNewRoots = { remainingRoots: 2 };
  expect(
    f.groups.prepare(
      1,
      () => 0,
      noMoreNewRoots,
      () => undefined,
    ),
  ).toBe(true);
  expect(noMoreNewRoots.remainingRoots).toBe(0);
});

it("moves multipart entries atomically and preserves their independent pressure opacity root", () => {
  const f = fixture();
  const a = f.entry("parts", 0, 3),
    b = f.entry("pressure", 1, 2);
  const pressure = new FakeNode(f.document, "g");
  pressure.setAttribute("opacity", "0.4");
  f.bands.content.insertBefore(pressure, fakeNode(firstPath(b)));
  for (const path of b.paths) pressure.append(fakeNode(path.node));
  b.group = pressure as never;
  f.groups.begin([f.run([a, b])]);
  expect(
    f.groups.prepare(
      10,
      () => 0,
      { remainingRoots: 2 },
      () => undefined,
    ),
  ).toBe(true);
  const suffix = fakeNode(f.groups.parentFor(a));
  expect(suffix.nodes).toEqual([...a.paths.map((p) => fakeNode(p.node)), pressure]);
  expect(b.group).toBe(pressure);
  expect(pressure.getAttribute("opacity")).toBe("0.4");
  f.groups.beginCommit();
  f.groups.canonical(a);
  f.groups.canonical(b);
  expect(pressure.parent).toBe(fakeNode(f.groups.parentFor(a)));
  f.groups.finishCommit();
  expect(
    f.groups.cleanup(
      10,
      () => 0,
      () => undefined,
    ),
  ).toBe(true);
  expect(f.flattened(f.bands.content)).toEqual(["parts", "parts", "parts", "pressure", "pressure"]);
  expect(pressure.getAttribute("opacity")).toBe("0.4");
});

it("uses actual parents for topology replacement and the frontier for detached members", () => {
  const f = fixture();
  const a = f.entry("a", 0, 2),
    b = f.entry("b", 1),
    c = f.entry("c", 2);
  f.groups.begin([f.run([a, b, c])]);
  f.groups.prepare(
    10,
    () => 0,
    { remainingRoots: 2 },
    () => undefined,
  );
  const suffix = f.groups.parentFor(b);
  expect(f.groups.placement(a, b).before).toBe(firstPath(b));
  f.groups.beginCommit();
  f.groups.canonical(a);
  const prefix = f.groups.parentFor(a);
  const old = a.paths[0]!;
  const replacement = new FakeNode(f.document, "path");
  replacement.setAttribute("data-id", "a");
  prefix.insertBefore(replacement as never, old.node);
  fakeNode(old.node).remove();
  a.paths[0] = { ...old, node: replacement as never };
  expect(f.groups.parentFor(a)).toBe(prefix);
  fakeNode(firstPath(a)).remove();
  fakeNode(firstPath(b)).remove();
  expect(f.groups.parentFor(a)).toBe(prefix);
  expect(f.groups.parentFor(b)).toBe(suffix);
  // A detached visibility exit is released without accidentally remounting it.
  f.groups.publish(null);
  const released: string[] = [];
  expect(
    f.groups.cleanup(
      10,
      () => 0,
      (e) => released.push(e.id),
    ),
  ).toBe(true);
  expect(f.flattened(f.bands.content)).toEqual(["a", "c"]);
  expect(released).toEqual(["a", "b", "c"]);
});

it("bounds pointer transform writes by two band runs and normalizes in original rank order", () => {
  const f = fixture();
  const a = f.entry("a", 0, 1, "highlight"),
    b = f.entry("b", 1, 1, "content");
  f.groups.begin([f.run([b]), f.run([a])]);
  expect(
    f.groups.prepare(
      10,
      () => 0,
      { remainingRoots: 4 },
      () => undefined,
    ),
  ).toBe(true);
  const writes = f.instrumentation.contentAttributeWrites;
  f.groups.publish("matrix(1 0 0 1 2 3)");
  expect(f.instrumentation.contentAttributeWrites - writes).toBe(2);
  f.groups.beginCommit();
  expect(f.groups.pendingCanonical).toBe(a);
  expect(() => f.groups.canonical(b)).toThrow("monotonic");
  f.groups.canonical(a);
  expect(f.groups.pendingCanonical).toBe(b);
  f.groups.canonical(b);
  expect(f.groups.pendingCanonical).toBeUndefined();
  f.groups.finishCommit();
  f.groups.cleanup(
    10,
    () => 0,
    () => undefined,
  );
  expect(f.flattened(f.bands.highlight)).toEqual(["a"]);
  expect(f.flattened(f.bands.content)).toEqual(["b"]);
});
