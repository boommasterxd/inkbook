import { expect, it, vi } from "vitest";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import { updateActiveSceneChrome } from "../../../../../src/obsidian/embeds/active-scene/active-scene-chrome";
import type { InkbookEditorChromeProps } from "../../../../../src/rendering/ui/editor-chrome";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene";
import { createEditorChromeProps } from "../../../../fixtures/editor-chrome";
import { createSceneFixture } from "../../../../fixtures/rendering/scene";
import { snapshot } from "../../../../unit/domain/schema/fixtures";
import {
  FakeSceneStore,
  fakeNode,
  fakeRectangleRecord,
} from "../../../../unit/rendering/scene/fakes";

function setup() {
  const store = new FakeSceneStore();
  const records = Array.from({ length: 200 }, (_, index) =>
    fakeRectangleRecord(`cleanup-${String(index)}`, index, 10),
  );
  for (const record of records) store.records.set(record.id, record);
  const history = new ActiveEditorHistory({
    commitBandOrder: vi.fn(),
    commitElements: vi.fn(),
    commitPage: vi.fn(),
    removeElements: vi.fn(),
    replaceElements: vi.fn(),
  });
  const chrome = {
    ready: Promise.resolve(true),
    unmount: vi.fn(),
    update: vi.fn<(props: InkbookEditorChromeProps) => void>(),
  };
  const layout = { chromeChanged: vi.fn<(key: string) => void>() };
  let renderer: SvgSceneRenderer;
  const fixture = createSceneFixture(snapshot().page, store, undefined, {
    onSceneCommitted: () => {
      if (!renderer.hasPendingSceneCommit) updateActiveSceneChrome(chrome, controller, layout);
    },
  });
  renderer = fixture.renderer;
  renderer.setReducedMotion(true);
  const base = createEditorChromeProps(renderer.svg.ownerDocument);
  const controller = {
    chromeProps: () => ({
      ...base,
      toolbarState: { ...base.toolbarState, canUndo: history.canUndo, canRedo: history.canRedo },
    }),
  };
  const apply = (removed: boolean): boolean => {
    if (removed)
      renderer.setElementFade(
        records.map(({ id }) => id),
        220,
      );
    for (const record of records) {
      if (removed) store.records.delete(record.id);
      else store.records.set(record.id, record);
    }
    renderer.applyDelta({
      affected: records.map(({ id, element }) => ({
        after: removed ? null : element,
        before: removed ? element : null,
        domains: ["visibility"],
        id,
      })),
    });
    return true;
  };
  return { ...fixture, apply, chrome, history, layout };
}

it("publishes Undo and Redo chrome state before obsolete SVG cleanup finishes", async () => {
  const h = setup();
  h.scheduler.runAll();
  expect(h.chrome.update.mock.lastCall?.[0].toolbarState).toMatchObject({ canUndo: false });
  const initialLayoutKey: unknown = h.layout.chromeChanged.mock.lastCall?.[0];
  h.apply(true);
  h.history.registerApplied({
    payloadBytes: 200,
    redo: () => Promise.resolve(h.apply(true)),
    undo: () => Promise.resolve(h.apply(false)),
  });
  h.scheduler.runNext();
  expectCleanupWithUndo(h);
  expect(h.layout.chromeChanged).toHaveBeenLastCalledWith(initialLayoutKey);

  expect(await h.history.undoAsync()).toBe(true);
  h.scheduler.runAll();
  expect(h.chrome.update.mock.lastCall?.[0].toolbarState).toMatchObject({
    canUndo: false,
    canRedo: true,
  });
  expect(h.renderer.mountedCount).toBe(200);

  expect(await h.history.redoAsync()).toBe(true);
  h.scheduler.runNext();
  expectCleanupWithUndo(h);
  h.scheduler.runAll();
  expect(h.renderer.mountedCount).toBe(0);
  h.history.dispose();
  h.renderer.destroy();
});

function expectCleanupWithUndo(h: ReturnType<typeof setup>): void {
  expect(h.scheduler.pendingCount).toBe(1);
  expect(fakeNode(h.renderer.svg).nodes[1]!.nodes[4]!.nodes.length).toBeGreaterThan(0);
  expect(h.renderer.hasPendingSceneCommit).toBe(false);
  expect(h.chrome.update.mock.lastCall?.[0].toolbarState).toMatchObject({
    canUndo: true,
    canRedo: false,
  });
}
