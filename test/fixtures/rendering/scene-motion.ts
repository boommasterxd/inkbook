import { vi } from "vitest";
import type { InkElementV1 } from "../../../src/domain/schema/public";
import type { SceneContentRenderer } from "../../../src/rendering/scene/content-renderer";
import type { SceneDom } from "../../../src/rendering/scene/scene-dom";
import { createInstrumentation } from "../../../src/rendering/scene/instrumentation";
import { SceneMotionController } from "../../../src/rendering/scene/scene-motion-controller";
import { FakeDocument, FakeNode, fakeRectangleRecord } from "../../unit/rendering/scene/fakes";

export function createMotionHarness(count: number, budget: number) {
  let time = 0;
  const writes: string[] = [];
  const content = {
    hasMounted: () => true,
    applyElementPreview: (element: InkElementV1) => {
      writes.push(element.id);
      time += budget;
    },
    clearElementPreview: vi.fn(),
    setElementMotion: vi.fn(),
  };
  const document = new FakeDocument();
  const motion = new SceneMotionController(
    {
      selectionOverlayPath: new FakeNode(document, "path"),
      selectionHandlePath: new FakeNode(document, "path"),
    } as unknown as SceneDom,
    content as unknown as SceneContentRenderer,
    createInstrumentation(),
    false,
  );
  motion.applyDelta(
    Array.from({ length: count }, (_, index) => {
      const element = fakeRectangleRecord(String(index), index, index).element;
      return { id: element.id, before: element, after: element, domains: ["geometry"] as const };
    }),
  );
  writes.length = 0;
  return { motion, content, writes, now: () => time, deadline: () => time + budget };
}
