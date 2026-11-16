import { expect, it } from "vitest";
import {
  ImageResourceCapacityError,
  SessionImageResources,
  type PreparedImageResources,
} from "../../../../../src/obsidian/embeds/document-session/session-image-resources";
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
    ImageResourceCapacityError,
  );
  expect(images.resources).toBe(retained);
  expect(images.resource(small.id)).toBeUndefined();
  expect(images.resource(assets[8]!.id)).toBeUndefined();
  expect(images.changes).toBeUndefined();
});

it("admits two Ultra resources without increasing the retained session pixel capacity", async () => {
  const images = new SessionImageResources(snapshot([]));
  const context = { active: () => true, scheduler: new TestWorkScheduler() };
  const assets = await Promise.all([
    capacityImageResource(0, 4000),
    capacityImageResource(1, 4000),
  ]);
  await images.add(assets, context);
  const retained = images.resources;
  expect(retained).toEqual(assets);
  expect(retained.reduce((sum, asset) => sum + asset.width * asset.height, 0)).toBe(
    IMAGE_LIMITS.documentPixels,
  );
  await expect(images.add([await validImageResource()], context)).rejects.toThrow(
    "including retained history",
  );
  expect(images.resources).toBe(retained);
});

it("keeps preparations private and consumes only tokens owned by this session", async () => {
  const asset = await validImageResource();
  const images = new SessionImageResources(snapshot([]));
  const foreign = new SessionImageResources(snapshot([]));
  const token = await images.prepare([asset], {
    active: () => true,
    scheduler: new TestWorkScheduler(),
  });
  expect(token).not.toBeNull();
  expect(images.resources).toEqual([]);
  expect(images.resource(asset.id)).toBeUndefined();
  expect(images.changes).toBeUndefined();
  expect(() => foreign.prepareCommit(token!)).toThrow("not owned");
  expect(() => images.prepareCommit({} as PreparedImageResources)).toThrow("not owned");
  const publish = images.prepareCommit(token!);
  expect(images.resources).toEqual([]);
  publish();
  expect(images.resource(asset.id)).toBe(asset);
  expect(images.changes).toEqual([asset]);
  expect(() => images.prepareCommit(token!)).toThrow("was used");
});

it("discards cancelled cooperative preparation while the document remains active", async () => {
  const asset = await validImageResource();
  const images = new SessionImageResources(snapshot([]));
  let cancelled = false;
  const scheduler = new TestWorkScheduler({
    checkpoint: () => {
      cancelled = true;
      return Promise.resolve();
    },
  });
  expect(
    await images.prepare([asset], { active: () => true, scheduler, isCancelled: () => cancelled }),
  ).toBeNull();
  expect(images.resources).toEqual([]);
  expect(images.changes).toBeUndefined();
});

it("rechecks current capacity at commit and preserves another admission when a prepared batch no longer fits", async () => {
  const assets = await Promise.all([
    capacityImageResource(0, 4000),
    capacityImageResource(1, 4000),
  ]);
  const images = new SessionImageResources(snapshot([]));
  const context = { active: () => true, scheduler: new TestWorkScheduler() };
  const token = await images.prepare(assets, context);
  const small = await validImageResource();
  await images.add([small], context);
  images.acknowledge();
  const retained = images.resources;
  expect(() => images.prepareCommit(token!)).toThrow("including retained history");
  expect(images.resources).toBe(retained);
  expect(images.resources).toEqual([small]);
  expect(images.changes).toBeUndefined();
  expect(() => images.prepareCommit(token!)).toThrow("was used");
});
