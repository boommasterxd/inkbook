import type { PageV1 } from "../../../src/domain/schema/public";
import { SvgSceneRenderer, type SceneStorePort } from "../../../src/rendering/scene";
import { asElement, FakeDocument, FakeNode, FakeScheduler } from "../../unit/rendering/scene/fakes";

export function createSceneFixture(page: PageV1, store: SceneStorePort) {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: { readViewport: () => ({ height: 1000, left: 0, top: 0, width: 2048 }) },
    page,
    store,
    scheduler,
  });
  return { renderer, scheduler };
}
