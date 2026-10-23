import { expect, vi } from "vitest";
import type {
  PreparedScenePathEntry,
  ScenePathPreparation,
  ScenePathPreparationObserver,
} from "../../../src/domain/geometry/prepared-scene-paths";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { ElementStore } from "../../../src/domain/store/public";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { DocumentPathPreparation } from "../../../src/rendering/scene/content/document-path-preparation";
import { ScenePathCache } from "../../../src/rendering/scene/content/path-cache";
import { indexedStroke } from "../editor/stroke";

/** Observes real lazy order reads and worker-boundary canonical path construction. */
export function createDocumentPathFixture(count = 3, cache = new ScenePathCache()) {
  const elements = Array.from({ length: count }, (_, index) => indexedStroke(index));
  const domain = new ElementStore(elements);
  const store = new ElementSceneStore(domain);
  const work = { orderReads: 0, builds: 0 };
  const beginOrder = domain.beginOrder.bind(domain);
  vi.spyOn(domain, "beginOrder").mockImplementation(() => {
    const cursor = beginOrder();
    const advance = cursor.advance.bind(cursor);
    vi.spyOn(cursor, "advance").mockImplementation(() => {
      const step = advance();
      if (step.id !== undefined) work.orderReads += 1;
      return step;
    });
    return cursor;
  });
  const build = (ids: readonly string[]) => {
    return ids.map((id) => {
      work.builds += 1;
      return { id, parts: buildElementPathParts(store.get(id)!.element) };
    });
  };
  const prepare = vi.fn(async (ids: readonly string[]) => build(ids));
  store.prepareScenePaths = prepare;
  const ready = vi.fn();
  const preparation = new DocumentPathPreparation(store, cache, ready);
  return { cache, domain, elements, store, work, build, prepare, ready, preparation };
}

export function deferDocumentPaths(fixture: ReturnType<typeof createDocumentPathFixture>) {
  let observer!: ScenePathPreparationObserver;
  let signal!: AbortSignal;
  let finish!: (paths: readonly PreparedScenePathEntry[] | undefined) => void;
  fixture.store.prepareScenePaths = vi.fn<ScenePathPreparation>((_ids, cancellation, progress) => {
    signal = cancellation;
    observer = progress!;
    return new Promise<readonly PreparedScenePathEntry[] | undefined>((resolve) => {
      finish = resolve;
    });
  });
  return {
    observer: () => observer,
    signal: () => signal,
    finish: (paths: readonly PreparedScenePathEntry[] | undefined) => finish(paths),
  };
}

/** Observes cancellation without allowing contour adoption inside the pause call. */
export function pauseDocumentPaths(
  fixture: ReturnType<typeof createDocumentPathFixture>,
  signal: AbortSignal,
) {
  const adopt = vi.spyOn(fixture.cache, "retainSpeculative");
  fixture.preparation.pause();
  expect(signal.aborted).toBe(true);
  expect(adopt).not.toHaveBeenCalled();
  return adopt;
}

export async function completeDocumentPaths(fixture: ReturnType<typeof createDocumentPathFixture>) {
  let frames = 0;
  while (fixture.preparation.needsWork && frames++ < 100) {
    if (fixture.cache.speculativeCapacityBytes() === 0) break;
    fixture.preparation.prepare(Infinity, () => 0);
    await Promise.resolve();
  }
  if (frames >= 100) throw new Error("Document preparation did not settle.");
}
