import { afterEach, vi } from "vitest";
import type { ImageElementV3, ImageResourceV3 } from "../../../src/domain/schema/public";
import { SvgSceneRenderer } from "../../../src/rendering/scene/scene-renderer";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import {
  FakeSceneStore,
  FakeScheduler,
  fakeRectangleRecord,
} from "../../unit/rendering/scene/fakes";
import { createSceneRecord, createIndexedSceneStore } from "./scene";
import { createWorkerSnapshot } from "../persistence/worker-snapshot";

/** Each importing test suite owns independent scenes and releases them after every case. */
export function useImageSceneCleanup(): (scene: SvgSceneRenderer) => SvgSceneRenderer {
  const scenes: SvgSceneRenderer[] = [];
  afterEach(() => {
    for (const scene of scenes.splice(0)) scene.destroy();
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });
  return (scene) => {
    scenes.push(scene);
    return scene;
  };
}

export function imageElement(id = "image", y = 20): ImageElementV3 {
  return {
    id,
    kind: "image",
    createdAt: 1,
    rotation: 0,
    x: 20,
    y,
    width: 200,
    height: 100,
    pivot: { x: 120, y: y + 50 },
    assetId: "a".repeat(64),
    crop: { x: 10, y: 20, width: 400, height: 200 },
  };
}

export function imageSceneFixture(count = 2, reducedMotion = true, deferInitialOverscan = false) {
  installObsidianDomHelpers();
  const container = document.createElement("div");
  document.body.append(container);
  const records = new FakeSceneStore();
  for (let index = 0; index < count; index += 1) {
    const element = imageElement(`image-${index}`, index < 2 ? 20 : 2000 + index * 200);
    records.records.set(element.id, createSceneRecord(element, index));
  }
  records.records.set("shape", fakeRectangleRecord("shape", 0, 300));
  const highlight = fakeRectangleRecord("highlight", 0, 300);
  records.records.set("highlight", { ...highlight, band: "highlight" });
  const indexed = createIndexedSceneStore(records);
  const resource: ImageResourceV3 = {
    id: "a".repeat(64),
    mimeType: "image/png",
    width: 640,
    height: 480,
    data: "aW1hZ2U=",
  };
  const resolve = vi.fn((id: string) => (id === resource.id ? resource : undefined));
  const scheduler = new FakeScheduler();
  const scene = new SvgSceneRenderer({
    container,
    imageResource: resolve,
    page: createWorkerSnapshot([]).page,
    store: indexed.store,
    workScheduler: scheduler.workScheduler,
    reducedMotion,
    deferInitialOverscan,
    layout: { readViewport: () => ({ left: 0, top: 0, width: 1024, height: 500 }) },
  });
  return { scene, scheduler, records, resource, resolve, indexed };
}
