import type { ElementStore } from "../../../src/domain/store/public";
import type { PageV1 } from "../../../src/domain/schema/public";
import { indexedStroke } from "../../fixtures/editor/stroke";
import { FakeDocument, FakeNode, FakeScheduler, asElement } from "../../unit/rendering/scene/fakes";
import type { ComparisonImplementation } from "./contracts";

export const RENDERING_MODULES = [
  "domain/store/public",
  "obsidian/embeds/active-editor/scene-store",
  "rendering/scene/index",
] as const;
export const RENDERING_PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

export function renderingFixture(impl: ComparisonImplementation, count = 10_000) {
  const { ElementStore } =
    impl.get<typeof import("../../../src/domain/store/public")>("domain/store/public");
  const elements = Array.from({ length: count }, (_, index) => indexedStroke(index));
  return { store: new ElementStore(elements), elements, ids: elements.map(({ id }) => id) };
}

export function renderingScene(
  impl: ComparisonImplementation,
  store: ElementStore,
  scheduler = new FakeScheduler(),
  frameBudgetMs?: () => number,
) {
  const { SvgSceneRenderer } =
    impl.get<typeof import("../../../src/rendering/scene/index")>("rendering/scene/index");
  const { ElementSceneStore } = impl.get<
    typeof import("../../../src/obsidian/embeds/active-editor/scene-store")
  >("obsidian/embeds/active-editor/scene-store");
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(new FakeDocument(), "div")),
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: RENDERING_PAGE,
    scheduler,
    store: new ElementSceneStore(store),
    ...(frameBudgetMs === undefined ? {} : { frameBudgetMs }),
  });
  return { renderer, scheduler };
}

export class RenderingProfileScheduler extends FakeScheduler {
  constructor(private readonly hz: number) {
    super();
  }
  override now(): number {
    const value = this.time;
    this.time += ((1_000 / this.hz) * 0.55) / 4;
    return value;
  }
  override runNext(): void {
    this.time += 1_000 / this.hz;
    super.runNext();
  }
}

/** Start every paired operation from the same renderer, cache, versions, and scheduler state. */
export function freshRenderingKernel(
  factory: () => import("./contracts").ComparisonKernel,
): import("./contracts").ComparisonKernel {
  let kernel: import("./contracts").ComparisonKernel | undefined;
  const current = () => {
    if (kernel === undefined) throw new Error("Rendering operation was not reset.");
    return kernel;
  };
  return {
    async reset() {
      await kernel?.dispose();
      kernel = factory();
      await kernel.reset?.();
    },
    run: () => current().run(),
    verify: (result) => current().verify(result),
    measurementSamples: (result, metricId) => {
      const active = current();
      if (active.measurementSamples === undefined)
        throw new Error("Rendering phase samples are missing.");
      return active.measurementSamples(result, metricId);
    },
    async dispose() {
      await kernel?.dispose();
      kernel = undefined;
    },
  };
}

export function renderingMetricSamples(
  groups: Readonly<Record<string, readonly number[]>>,
  metricId: string,
): readonly number[] {
  const samples = groups[metricId];
  if (samples === undefined || !Object.prototype.hasOwnProperty.call(groups, metricId))
    throw new Error(`Unknown rendering metric: ${metricId}`);
  return samples;
}
