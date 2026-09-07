import { describe, expect, it, vi } from "vitest";

import { buildStrokePath } from "../../../../src/domain/geometry/stroke-path";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../src/domain/store/public";
import { CreationPreview } from "../../../../src/obsidian/embeds/active-editor/creation-preview";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";
import { activeEditorStoreHistory } from "../../../fixtures/obsidian/active-editor";
import {
  FakeDocument,
  FakeNode,
  FakeScheduler,
  asElement,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";

function setup() {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new ElementStore();
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: createWorkerSnapshot([]).page,
    scheduler,
    store: new ElementSceneStore(store),
  });
  store.subscribe((delta) =>
    renderer.applyDelta({
      affected: delta.changes.map(({ after, before, domains, id }) => ({
        after: (after?.element as InkElementV1 | undefined) ?? null,
        before: (before?.element as InkElementV1 | undefined) ?? null,
        domains,
        id,
      })),
    }),
  );
  const history = activeEditorStoreHistory(store);
  const defaults = createBuiltInSettings().toolDefaults;
  defaults.pen.width = 22;
  const create = (index: number, tool: "draw" | "highlighter" = "draw") => {
    const preview = new CreationPreview({
      defaults,
      history,
      identity: {
        createdAt: index,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      },
      renderer,
      start: {
        additive: false,
        kind: "tool-gesture",
        pointer: { pointerId: 1, pointerType: "pen", pressure: 0.5, x: 10, y: 10 },
        tool,
      },
    });
    preview.update({ pointerId: 1, pointerType: "pen", pressure: 0.7, x: 50, y: 20 });
    return preview;
  };
  scheduler.runAll();
  return { create, history, renderer, scheduler, store };
}

function paths(node: FakeNode): FakeNode[] {
  return node.nodes.flatMap((child) => (child.tagName === "path" ? [child] : paths(child)));
}

function liveTail(renderer: SvgSceneRenderer): FakeNode {
  const nodes = paths(fakeNode(renderer.svg));
  const tail = nodes.find(
    (node) =>
      node.attributes.get("fill-rule") === "nonzero" && !node.attributes.has("data-element-id"),
  );
  if (tail === undefined) throw new Error("Expected live pressure ink.");
  return tail;
}

describe("freehand commit handoff", () => {
  it("retains the same live nodes across commit and removes them only with mounted ink", () => {
    const { create, renderer, scheduler } = setup();
    const preview = create(1);
    const tail = liveTail(renderer);
    expect(preview.commit()).toBe(true);
    const handoff = tail.parent!;
    expect(handoff.parent).toBeDefined();
    expect(renderer.mountedCount).toBe(0);
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(1);
    expect(handoff.parent).toBeUndefined();
    expect(renderer.instrumentation().motionEntrances).toBe(0);
    renderer.destroy();
  });

  it("preserves pending ink through deferred frames and a subsequent canceled gesture", () => {
    const { create, renderer, scheduler } = setup();
    const first = create(1);
    const tail = liveTail(renderer);
    first.commit();
    const handoff = tail.parent!;
    const second = create(2, "highlighter");
    second.commit();
    create(3).revert();
    const now = vi.spyOn(scheduler, "now").mockReturnValue(1000);
    scheduler.runNext();
    expect(renderer.mountedCount).toBe(0);
    expect(handoff.parent).toBeDefined();
    now.mockRestore();
    scheduler.runAll();
    expect(renderer.mountedCount).toBe(2);
    expect(handoff.parent).toBeUndefined();
    expect(renderer.instrumentation().motionEntrances).toBe(0);
    renderer.destroy();
  });

  it("releases pending ink on undo and disposal", () => {
    const { create, history, renderer } = setup();
    const first = create(1);
    const firstTail = liveTail(renderer);
    first.commit();
    const firstHandoff = firstTail.parent!;
    history.undo();
    expect(firstHandoff.parent).toBeUndefined();
    const second = create(2);
    const secondTail = liveTail(renderer);
    second.commit();
    const secondHandoff = secondTail.parent!;
    renderer.destroy();
    expect(secondHandoff.parent).toBeUndefined();
  });

  it("clears unsuccessful history commits without retaining orphan ink", () => {
    const { create, history, renderer } = setup();
    const preview = create(1);
    const tail = liveTail(renderer);
    vi.spyOn(history, "create").mockReturnValue(false);
    expect(preview.commit()).toBe(false);
    expect(tail.parent).toBeUndefined();
    const next = create(2);
    const nextTail = liveTail(renderer);
    vi.spyOn(history, "create").mockImplementation(() => {
      throw new Error("commit failed");
    });
    expect(() => next.commit()).toThrow("commit failed");
    expect(nextTail.parent).toBeUndefined();
    renderer.destroy();
  });
});

describe("canonical pressure handoff", () => {
  it("keeps dense pressure ink identical through live handoff and selection rematerialization", () => {
    const { create, renderer, scheduler, store } = setup();
    const preview = create(1);
    for (let index = 0; index < 90; index += 1) {
      preview.update({
        pointerId: 1,
        pointerType: "pen",
        pressure: 0.3 + (index % 7) / 10,
        x: 20 + index * 0.4,
        y: 40 + Math.sin(index / 2) * 20,
      });
    }
    const live = paths(fakeNode(renderer.svg))
      .filter((node) => node.attributes.get("fill-rule") === "nonzero")
      .map((node) => node.attributes.get("d"))
      .join("");
    expect(preview.commit()).toBe(true);
    const element = store.get("00000000-0000-4000-8000-000000000001")!.element;
    if (element.kind !== "stroke") throw new Error("Expected committed pressure stroke.");
    const wireElement = { ...element, points: [...element.points] };
    const canonical = buildStrokePath(wireElement).d;
    expect(live).toBe(canonical);
    scheduler.runAll();
    const committed = paths(fakeNode(renderer.svg)).find(
      (node) => node.attributes.get("fill-rule") === "nonzero",
    )!;
    expect(committed.attributes.get("d")).toBe(canonical);
    renderer.setElementPreviews([wireElement], 1);
    scheduler.runAll();
    expect(committed.attributes.get("d")).toBe(canonical);
    renderer.clearElementPreviews();
    scheduler.runAll();
    expect(committed.attributes.get("d")).toBe(canonical);
    renderer.destroy();
  });
});
