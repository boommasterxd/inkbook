import { describe, expect, it } from "vitest";

import { buildElementPathParts } from "../../../../src/domain/geometry/public";
import type {
  PageV1,
  StrokeStyleV1,
  StraightHighlighterElementV1,
} from "../../../../src/domain/schema/public";
import { LiveStrokeBuilder } from "../../../../src/editor/tools/live-stroke";
import { pathPresentation } from "../../../../src/rendering/scene/element-presentation";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";

import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeNode,
} from "../../../unit/rendering/scene/fakes";

const page: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2000,
  lockedBufferLines: 1,
  margin: 24.3,
};

function setup(): { renderer: SvgSceneRenderer; scheduler: FakeScheduler } {
  const document = new FakeDocument();
  const container = new FakeNode(document, "div");
  const scheduler = new FakeScheduler();
  const renderer = new SvgSceneRenderer({
    container: asElement(container),
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page,
    scheduler,
    store: new FakeSceneStore(),
  });
  renderer.setPage(page, 500);
  return { renderer, scheduler };
}

function straightHighlighter(): StraightHighlighterElementV1 {
  return {
    bend: null,
    createdAt: 0,
    end: { x: 80, y: 40 },
    endNode: "none",
    id: "highlight-preview",
    kind: "straight-highlighter",
    pivot: { x: 45, y: 40 },
    rotation: 0,
    start: { x: 10, y: 40 },
    startNode: "none",
    style: {
      color: { type: "rgba", value: "#EAB308FF" },
      opacity: 0.4,
      pressureEnabled: false,
      smoothing: 0.5,
      width: 8,
    },
  };
}

function sceneGroups(renderer: SvgSceneRenderer) {
  const camera = fakeNode(renderer.svg).nodes[1]!;
  return {
    camera,
    contentGroup: camera.nodes[4]!,
    highlightGroup: camera.nodes[3]!,
    liveGroup: camera.nodes[5]!,
    liveStrokeGroup: camera.nodes[6]!,
  };
}

describe("live highlighter scene bands", () => {
  it("places a freehand highlighter preview below the content band", () => {
    const { renderer, scheduler } = setup();
    scheduler.runAll();
    const { camera, contentGroup, highlightGroup, liveGroup, liveStrokeGroup } =
      sceneGroups(renderer);
    const style: StrokeStyleV1 = straightHighlighter().style;
    const builder = new LiveStrokeBuilder({
      input: { pressureSource: "simulated", zoom: 1 },
      style,
    });

    renderer.updateLiveStroke(
      builder.append({ pressure: 0.5, time: 0, x: 10, y: 20 }),
      style,
      "highlighter",
    );

    expect(liveStrokeGroup.parent).toBe(highlightGroup);
    expect(highlightGroup.nodes[highlightGroup.nodes.length - 1]).toBe(liveStrokeGroup);
    expect(camera.nodes.indexOf(highlightGroup)).toBeLessThan(camera.nodes.indexOf(contentGroup));
    renderer.clearLiveStroke();
    expect(liveStrokeGroup.parent).toBe(camera);
    expect(camera.nodes.indexOf(liveStrokeGroup)).toBeGreaterThan(camera.nodes.indexOf(liveGroup));
  });

  it("places a straight highlighter preview below the content band", () => {
    const { renderer, scheduler } = setup();
    scheduler.runAll();
    const { camera, contentGroup, highlightGroup, liveGroup, liveStrokeGroup } =
      sceneGroups(renderer);
    const element = straightHighlighter();
    const part = buildElementPathParts(element)[0];
    if (part === undefined) throw new Error("Expected straight-highlighter path geometry.");

    renderer.setLivePath({
      band: "highlight",
      parts: [{ d: part.d, presentation: pathPresentation(element, part) }],
    });
    scheduler.runAll();

    expect(liveGroup.parent).toBe(highlightGroup);
    expect(highlightGroup.nodes[highlightGroup.nodes.length - 1]).toBe(liveGroup);
    expect(camera.nodes.indexOf(highlightGroup)).toBeLessThan(camera.nodes.indexOf(contentGroup));
    renderer.setLivePath(null);
    scheduler.runAll();
    expect(liveGroup.parent).toBe(camera);
    expect(camera.nodes.indexOf(liveGroup)).toBeLessThan(camera.nodes.indexOf(liveStrokeGroup));
  });
});
