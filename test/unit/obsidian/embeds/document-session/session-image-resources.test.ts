import { expect, it } from "vitest";
import { SessionImageResources } from "../../../../../src/obsidian/embeds/document-session/session-image-resources";
import { IMAGE_LIMITS } from "../../../../../src/domain/images/image-limits";
import { TestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import { capacityImageResource, validImageResource } from "../../../../fixtures/persistence/images";
import { snapshot } from "../../../domain/schema/fixtures";

it("admits immutable assets once and retains them after worker-delta acknowledgement", async () => {
  const asset = await validImageResource();
  const images = new SessionImageResources(snapshot([]));
  const context = { active: () => true, scheduler: new TestWorkScheduler() };
  await images.add([asset], context);
  expect(images.resource(asset.id)).toBe(asset);
  expect(Object.isFrozen(images.resource(asset.id))).toBe(true);
  expect(images.changes).toEqual([asset]);
  images.acknowledge();
  await images.add([asset], context);
  expect(images.changes).toBeUndefined();
  expect(images.resources).toEqual([asset]);
  await expect(images.add([{ ...asset, width: 2 }], context)).rejects.toThrow(
    "Conflicting image resource identity",
  );
  await expect(
    images.add(
      Array.from({ length: IMAGE_LIMITS.resources + 1 }, () => asset),
      context,
    ),
  ).rejects.toThrow("Too many");
  expect(images.resources).toEqual([asset]);
});

it("does not publish forged resources or resources whose session disappeared during validation", async () => {
  const asset = await validImageResource();
  const images = new SessionImageResources(snapshot([]));
  await expect(
    images.add([{ ...asset, id: "a".repeat(64) }], {
      active: () => true,
      scheduler: new TestWorkScheduler(),
    }),
  ).rejects.toThrow();
  expect(images.resources).toEqual([]);
  let active = true;
  const scheduler = new TestWorkScheduler({
    checkpoint: () => {
      active = false;
      return Promise.resolve();
    },
  });
  await expect(images.add([asset], { active: () => active, scheduler })).rejects.toThrow(
    "unavailable",
  );
  expect(images.resources).toEqual([]);
  expect(images.changes).toBeUndefined();
});

it("counts retained unique assets against the pixel budget and rejects an overflowing batch atomically", async () => {
  const images = new SessionImageResources(snapshot([]));
  const context = { active: () => true, scheduler: new TestWorkScheduler() };
  const assets = await Promise.all(
    Array.from({ length: 9 }, (_, index) => capacityImageResource(index)),
  );
  expect(assets[0]!.width * assets[0]!.height * 8).toBe(IMAGE_LIMITS.documentPixels);
  await images.add([assets[0]!, assets[0]!], context);
  expect(images.resources).toHaveLength(1);
  await images.add(assets.slice(1, 8), context);
  images.acknowledge();
  const retained = images.resources;
  expect(retained).toHaveLength(8);
  await images.add([assets[0]!], context);
  expect(images.resources).toBe(retained);
  const small = await validImageResource();
  await expect(images.add([small, assets[8]!], context)).rejects.toThrow(
    "including retained history",
  );
  expect(images.resources).toBe(retained);
  expect(images.resource(small.id)).toBeUndefined();
  expect(images.resource(assets[8]!.id)).toBeUndefined();
  expect(images.changes).toBeUndefined();
});
