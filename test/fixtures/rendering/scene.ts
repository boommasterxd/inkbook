import { renderBandOf } from "../../../src/domain/commands/render-bands";
import { calculateElementBounds } from "../../../src/domain/geometry/bounds";
import type { SceneElementRecord } from "../../../src/rendering/scene/types";
import type { InkElementV1, PageV1 } from "../../../src/domain/schema/public";
import type { SceneRendererOptions, SceneViewport } from "../../../src/rendering/scene/types";
import { SvgSceneRenderer, type SceneStorePort } from "../../../src/rendering/scene";
import { asElement, FakeDocument, FakeNode, FakeScheduler } from "../../unit/rendering/scene/fakes";

export function createSceneFixture(
  page: PageV1,
  store: SceneStorePort,
  viewport: SceneViewport = { height: 1000, left: 0, top: 0, width: 2048 },
  options: Pick<SceneRendererOptions, "onSceneCommitted" | "frameBudgetMs"> = {},
) {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const renderer = new SvgSceneRenderer({
    ...options,
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => viewport },
    page,
    store,
    scheduler,
  });
  return { document, renderer, scheduler };
}

export function createSceneRecord(element: InkElementV1, rank = 0): SceneElementRecord {
  return {
    id: element.id,
    element,
    geometryVersion: 1,
    paintVersion: 1,
    rank,
    band: renderBandOf(element),
    bounds: calculateElementBounds(element),
  };
}
