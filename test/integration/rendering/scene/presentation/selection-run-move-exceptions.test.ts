import { afterEach, expect, it, vi } from "vitest";
import { moveSelection } from "../../../../../src/editor/selection/transform/transforms";
import { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { MovePreview } from "../../../../../src/obsidian/embeds/active-editor/previews/move-preview";
import { elementReplacementPorts } from "../../../../fixtures/obsidian/element-mutation-ports";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { createSynchronousActiveEditorHistory } from "../../../../fixtures/obsidian/synchronous-active-editor-history";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import {
  assertCanonicalPath,
  commit,
  rect,
  scale,
  world,
} from "../../../../fixtures/rendering/selection-run-world";
import { FakeNode } from "../../../../unit/rendering/scene/fakes";

afterEach(() => vi.restoreAllMocks());

function move(
  f: ReturnType<typeof world>,
  prepared?: Pick<ConstructorParameters<typeof MovePreview>[0], "history" | "preparedHistory">,
) {
  return new MovePreview({
    history: createSynchronousActiveEditorHistory(f.store),
    preparedHistory: { commitMove: () => false } as never,
    ...prepared,
    renderer: f.renderer,
    sceneStore: f.port,
    selection: () => f.selection,
    setSelection: vi.fn(),
    pageToScreen: (point) => point,
    start: {
      additive: false,
      kind: "element-move",
      tool: "select",
      pointer: pointer(0, 0),
    },
    store: f.store,
  });
}

function pointer(x: number, y: number) {
  return { x, y, pointerId: 1, pointerType: "pen" as const, pressure: 0.5 };
}

function physicalExceptions() {
  const group = Array.from({ length: 600 }, (_, index) => rect(index));
  const separator = rect(600),
    extra = rect(601);
  const selected = [...group, extra];
  const f = world([...group, separator, extra], selected);
  return { f, selected, separator, extra };
}

it.each([undefined, 0, 2])(
  "cancels physical exceptions and retained grouped bases during resize commit %s",
  (resize) => {
    const { f, selected, separator } = physicalExceptions();
    try {
      expect(f.svg.getAttribute("data-inkbook-run-ready")).toBe("true");
      let canonical = selected;
      if (resize !== undefined) {
        canonical = scale(f, resize, 1) as typeof selected;
        commit(f, canonical);
        // Keep the canonical handoff outstanding while the next gesture starts.
        expect(f.scheduler.pendingCount).toBeGreaterThan(0);
      }
      const probes = [canonical[0]!, canonical[255]!, canonical[599]!, canonical[600]!];
      for (const element of probes) assertCanonicalPath(f, element);
      for (const delta of [
        { x: 20, y: 10 },
        { x: -10, y: 5 },
      ]) {
        const preview = move(f);
        const writes = vi.spyOn(FakeNode.prototype, "setAttribute");
        preview.update(pointer(delta.x, delta.y));
        const parentLimit = resize === undefined ? 2 : 4;
        // One physical exception owns one ink root and one center trace.
        expect(
          writes.mock.calls.filter(([name]) => name === "transform").length,
        ).toBeLessThanOrEqual(parentLimit + 2);
        writes.mockRestore();
        for (const element of moveSelection(probes, delta)) assertCanonicalPath(f, element);
        assertCanonicalPath(f, separator);
        preview.revert();
        for (const element of probes) assertCanonicalPath(f, element);
        assertCanonicalPath(f, separator);
      }
      f.scheduler.runAll(1000);
      for (const element of probes) assertCanonicalPath(f, element);
    } finally {
      f.dispose();
    }
  },
);

it("retains committed physical exceptions before cancelling an immediate next public move", async () => {
  const { f, selected, separator, extra } = physicalExceptions();
  const unsubscribe = f.store.subscribe((delta) =>
    f.renderer.applyDelta({ affected: sceneDeltaEntries(delta) }),
  );
  const history = createSynchronousActiveEditorHistory(f.store);
  const preparedHistory = new PreparedElementHistory({
    history,
    model: {
      store: f.store,
      revision: 0,
      ...elementReplacementPorts(f.store),
    } as never,
    motion: f.renderer,
    isAttached: () => true,
    onPendingChanged: () => undefined,
    workScheduler: immediateWorkScheduler(),
  });
  try {
    const first = move(f, { history, preparedHistory });
    first.update(pointer(20, 10));
    expect(first.commit()).toBe(true);
    await vi.waitFor(() => expect(history.commandCount).toBe(1));
    const canonical = moveSelection([selected[0]!, selected[599]!, extra], {
      x: 20,
      y: 10,
    });
    for (const element of canonical) assertCanonicalPath(f, element);
    expect(f.scheduler.pendingCount).toBeGreaterThan(0);
    const second = move(f);
    second.update(pointer(-5, 4));
    for (const element of moveSelection(canonical, { x: -5, y: 4 }))
      assertCanonicalPath(f, element);
    second.revert();
    for (const element of canonical) assertCanonicalPath(f, element);
    f.scheduler.runAll(1000);
    for (const element of canonical) assertCanonicalPath(f, element);
    assertCanonicalPath(f, separator);
  } finally {
    preparedHistory.dispose();
    history.dispose();
    unsubscribe();
    f.dispose();
  }
});
