import { vi } from "vitest";

import type { SceneToolCursor } from "../../../../src/rendering/scene/tool-cursor";
import { FakeNode, fakeNode } from "../../../unit/rendering/scene/fakes";
import {
  createInteractionFixture,
  createInteractionRenderer,
} from "./interaction-refresh-profile-fixture";

export function cursorState(x: number, icon: FakeNode): SceneToolCursor {
  return {
    color: { type: "theme-text" },
    kind: "tool",
    opacity: 0.4,
    icon: icon as unknown as SVGSVGElement,
    x,
    y: 40,
  };
}

export function observeWork(
  store: ReturnType<typeof createInteractionFixture>["store"],
  root: FakeNode,
  inputSurface: HTMLElement,
) {
  return {
    content: [
      vi.spyOn(root.ownerDocument, "createElementNS"),
      vi.spyOn(root.ownerDocument, "createDocumentFragment"),
      vi.spyOn(fakeNode(inputSurface).ownerDocument, "createElementNS"),
      vi.spyOn(fakeNode(inputSurface).ownerDocument, "createDocumentFragment"),
      vi.spyOn(store, "get"),
      vi.spyOn(store, "query"),
      vi.spyOn(store, "beginQuery"),
    ],
    traversal: vi.spyOn(FakeNode.prototype, "children", "get"),
    append: vi.spyOn(FakeNode.prototype, "append"),
    insert: vi.spyOn(FakeNode.prototype, "insertBefore"),
    remove: vi.spyOn(FakeNode.prototype, "remove"),
    system: vi.spyOn(fakeNode(inputSurface).style, "setProperty"),
    write: vi.spyOn(FakeNode.prototype, "setAttribute"),
  };
}

export function createCursorFixture() {
  const { store } = createInteractionFixture();
  const { renderer, scheduler } = createInteractionRenderer(store);
  scheduler.runAll();
  const root = fakeNode(renderer.svg);
  const cursor = fakeNode(renderer.inputSurface).ownerDocument.body.nodes[0]!.nodes[0]!;
  return { store, renderer, scheduler, root, cursor };
}
