import { expect, vi } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import { scaleElement } from "../../../src/editor/selection/transform/transforms";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { strokeLocalGeometry } from "../../../src/domain/geometry/stroke-position";
import type {
  PreparedScenePathEntry,
  ScenePathPreparationObserver,
} from "../../../src/domain/geometry/prepared-scene-paths";
import type { SceneElementRecord } from "../../../src/rendering/scene/types";
import { createSceneFixture, sceneDeltaEntries } from "./scene";
import { createTestStroke, createWorkerSnapshot } from "../persistence/worker-snapshot";
import { armSelectionCommit } from "./selection-runs";

export interface PendingDirtyPaths {
  readonly ids: readonly string[];
  readonly signal: AbortSignal;
  readonly options: ScenePathPreparationObserver | undefined;
  readonly records: readonly SceneElementRecord[];
  readonly resolve: (paths: readonly PreparedScenePathEntry[] | undefined) => void;
  readonly reject: (error: Error) => void;
}

/** Starts with canonical mounted ink, then controls the existing asynchronous worker boundary. */
export function dirtyGeometryScene(count = 1, pressureCount = count) {
  const original = Array.from({ length: count }, (_, index) => {
    const stroke = createTestStroke();
    return {
      ...stroke,
      style: { ...stroke.style, pressureEnabled: index >= count - pressureCount },
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    };
  });
  const store = new ElementStore(original);
  const port = new ElementSceneStore(store);
  const scene = createSceneFixture(
    createWorkerSnapshot([]).page,
    port,
    { height: 100, width: 100, left: 0, top: 0 },
    { scrollPreloadMarginPx: 100 },
  );
  scene.scheduler.runAll();
  const requests: PendingDirtyPaths[] = [];
  const prepare = vi.fn<NonNullable<typeof port.prepareScenePaths>>(
    (ids, signal, options) =>
      new Promise((resolve, reject) => {
        requests.push({
          ids,
          signal,
          options,
          records: ids.map((id) => port.get(id)!),
          resolve,
          reject,
        });
      }),
  );
  port.prepareScenePaths = prepare;
  return {
    ...scene,
    original,
    store,
    port,
    requests,
    prepare,
    replace: (factor = 2) => {
      const replacements = original.map((element) =>
        scaleElement(element, { x: 0, y: 0 }, { x: factor, y: 1 }),
      );
      armSelectionCommit({ renderer: scene.renderer, ids: replacements.map(({ id }) => id) });
      scene.renderer.applyDelta({ affected: sceneDeltaEntries(store.replaceMany(replacements)!) });
      return replacements;
    },
    deliver: (request: PendingDirtyPaths) => {
      const paths = request.records.map((record) => ({
        id: record.id,
        parts: buildElementPathParts(
          record.element.kind === "stroke" ? strokeLocalGeometry(record.element) : record.element,
        ),
      }));
      request.resolve(paths);
      return paths;
    },
    dispose: () => {
      scene.renderer.destroy();
      port.release();
      store.releasePreparedPressureGeometry();
    },
  };
}

/** Worker delivery wakes frames; a blocked renderer must not continually request its own frames. */
export async function drainDirtyGeometry(scene: ReturnType<typeof dirtyGeometryScene>) {
  let delivered = 0;
  for (let round = 0; round < 1000; round += 1) {
    scene.scheduler.runAll();
    if (delivered === scene.requests.length) return;
    for (; delivered < scene.requests.length; delivered += 1)
      scene.deliver(scene.requests[delivered]!);
    await Promise.resolve();
    await Promise.resolve();
  }
  expect.fail("Dirty canonical geometry did not settle.");
}

/** Uses the existing grouped resize feedback before handing a real committed delta to the scene. */
export function beginDirtyGeometryRun(scene: ReturnType<typeof dirtyGeometryScene>): void {
  const ids = scene.original.map(({ id }) => id);
  const selection = new Set(ids);
  scene.renderer.setSelectedElements(selection);
  scene.scheduler.runAll();
  scene.renderer.setProgressiveElementPreviews(
    ids,
    (id) => scaleElement(scene.port.get(id)!.element, { x: 0, y: 0 }, { x: 2, y: 1 }),
    1,
    {
      selection,
      selectionSize: ids.length,
      invertible: true,
      matrix: [2, 0, 0, 1, 0, 0],
      transform: "scale(2 1)",
      inverse: "scale(0.5 1)",
    },
  );
  scene.renderer.flushPointerFeedbackFrame(scene.scheduler.now());
  scene.scheduler.runAll();
  expect(
    scene.renderer.svg.getAttribute("data-inkbook-run-ready"),
    JSON.stringify({
      fallback: scene.renderer.svg.getAttribute("data-inkbook-run-fallback"),
      mounted: scene.renderer.mountedIds("content").length,
      selection: ids.length,
    }),
  ).toBe("true");
  expect(scene.renderer.svg.getAttribute("data-inkbook-run-feedback")).toBe("true");
}
