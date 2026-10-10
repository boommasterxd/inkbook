import { expect, it, vi } from "vitest";
import {
  completeDocumentPaths,
  createDocumentPathFixture,
  deferDocumentPaths,
} from "../../../fixtures/rendering/document-path-preparation";

it.each([false, true])(
  "transfers current delivered contours to foreground with paused=%s",
  async (paused) => {
    const fixture = createDocumentPathFixture(2);
    const remote = deferDocumentPaths(fixture);
    fixture.preparation.prepare(Infinity, () => 0);
    const paths = fixture.build(fixture.elements.map(({ id }) => id));
    remote.observer().onProgress(paths);
    if (paused) fixture.preparation.pause();
    const adopt = vi.spyOn(fixture.cache, "retainSpeculative");
    const transferred = fixture.preparation.takeReady(fixture.store.get(paths[0]!.id)!);
    expect(transferred).toBe(paths[0]!.parts);
    expect(fixture.preparation.takeReady(fixture.store.get(paths[0]!.id)!)).toBeUndefined();
    expect(adopt).not.toHaveBeenCalled();
    fixture.cache.retain(
      paths[0]!.id,
      fixture.store.get(paths[0]!.id)!.geometryVersion,
      transferred!,
    );
    if (!paused) {
      remote.finish(paths);
      await Promise.resolve();
    }
    fixture.store.prepareScenePaths = fixture.prepare;
    await completeDocumentPaths(fixture);
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.cache.statistics().entries).toBe(2);
    expect(fixture.preparation.memoryUsage()).toBe(0);
    fixture.preparation.release();
    expect(fixture.preparation.takeReady(fixture.store.get(paths[0]!.id)!)).toBeUndefined();
    fixture.store.release();
  },
);

it.each(["replace", "delete"] as const)(
  "rejects a %s contour even when foreground passes its stale record",
  async (change) => {
    const fixture = createDocumentPathFixture(1);
    const remote = deferDocumentPaths(fixture);
    fixture.preparation.prepare(Infinity, () => 0);
    const element = fixture.elements[0]!;
    const stale = fixture.store.get(element.id)!;
    remote.observer().onProgress(fixture.build([element.id]));
    fixture.preparation.pause();
    if (change === "replace")
      fixture.domain.replace(element.id, { ...element, style: { ...element.style, width: 4 } });
    else fixture.domain.remove([element.id]);
    expect(fixture.preparation.takeReady(stale)).toBeUndefined();
    fixture.store.prepareScenePaths = fixture.prepare;
    await completeDocumentPaths(fixture);
    expect(fixture.prepare.mock.calls.map(([ids]) => ids)).toEqual(
      change === "replace" ? [[element.id]] : [],
    );
    fixture.preparation.release();
    expect(fixture.preparation.memoryUsage()).toBe(0);
    fixture.store.release();
  },
);
