import { expect, it, vi } from "vitest";
import type { PageV1 } from "../../../../../src/domain/schema/public";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import { createSceneFixture } from "../../../../fixtures/rendering/scene";
import { FakeSceneStore, fakeNode } from "../../../../unit/rendering/scene/fakes";

const PAGE: PageV1 = {
  ...NAVIGATION_PAGE,
  background: { spacing: 50, type: "squares" },
};

it("commits CSS-pixel background coverage before expansion and restores the authoritative page", () => {
  const committed = vi.fn();
  const { renderer, scheduler } = createSceneFixture(PAGE, new FakeSceneStore(), undefined, {
    onSceneCommitted: committed,
  });
  renderer.setPage(PAGE, 200);
  renderer.setCamera({ x: 0, zoom: 0.2 });
  scheduler.runAll();
  const background = fakeNode(renderer.svg).nodes[1]!.nodes[1]!;
  const original = background.attributes.get("d");
  const proof = renderer.sceneCommitProof!;
  committed.mockClear();
  renderer.resetInstrumentation();

  renderer.setMinimumBackgroundBlockSize(360);
  expect(renderer.hasPendingSceneCommit).toBe(true);
  expect(renderer.sceneCommitProof).toBeUndefined();
  expect(background.attributes.get("d")).toBe(original);
  renderer.setMinimumBackgroundBlockSize(360);
  expect(scheduler.pendingCount).toBe(1);
  scheduler.runAll();
  expect(background.attributes.get("d")).toContain("V 1778.2");
  expect(renderer.sceneCommitProof).toBe(proof + 1);
  expect(committed).toHaveBeenCalledOnce();
  expect(renderer.instrumentation().backgroundBuilds).toBe(1);

  renderer.setMinimumBackgroundBlockSize(360);
  expect(scheduler.pendingCount).toBe(0);
  renderer.setMinimumBackgroundBlockSize(500);
  renderer.setMinimumBackgroundBlockSize(400);
  renderer.setCamera({ x: 0, zoom: 0.25 });
  expect(renderer.sceneCommitProof).toBeUndefined();
  scheduler.runAll();
  expect(background.attributes.get("d")).toContain("V 1577.7");
  renderer.setPage(PAGE, 2_000);
  scheduler.runAll();
  expect(background.attributes.get("d")).toContain("V 1977.7");
  renderer.setPage(PAGE, 200);
  renderer.setMinimumBackgroundBlockSize(0);
  renderer.setCamera({ x: 0, zoom: 0.2 });
  scheduler.runAll();
  expect(background.attributes.get("d")).toBe(original);
  renderer.destroy();
  expect(scheduler.pendingCount).toBe(0);
});

it("rejects invalid minimum sizes without invalidating the committed scene", () => {
  const { renderer, scheduler } = createSceneFixture(PAGE, new FakeSceneStore());
  scheduler.runAll();
  const proof = renderer.sceneCommitProof;
  for (const value of [NaN, Infinity, -Infinity, -1]) {
    expect(() => renderer.setMinimumBackgroundBlockSize(value)).toThrow(RangeError);
  }
  expect(renderer.sceneCommitProof).toBe(proof);
  expect(scheduler.pendingCount).toBe(0);
  renderer.setCamera({ x: 0, zoom: 0.5 });
  expect(renderer.sceneCommitProof).toBe(proof);
  scheduler.runAll();
  expect(renderer.sceneCommitProof).toBe(proof);
  renderer.destroy();
  expect(() => renderer.setMinimumBackgroundBlockSize(360)).toThrow("destroyed");
});
