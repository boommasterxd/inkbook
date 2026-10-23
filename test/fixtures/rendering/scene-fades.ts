import { FakeNode, fakeNode, type FakeAnimation } from "../../unit/rendering/scene/fakes";

export function activeFades(node: Element | FakeNode): FakeAnimation[] {
  return (node instanceof FakeNode ? node : fakeNode(node)).getAnimations();
}

export function activeFade(node: Element | FakeNode): FakeAnimation {
  const animations = activeFades(node);
  if (animations.length !== 1)
    throw new Error(`Expected one active fade, got ${String(animations.length)}`);
  return animations[0]!;
}

export function fadeFrames(node: Element | FakeNode): readonly string[] {
  const opacity = activeFade(node).keyframes.opacity;
  if (!Array.isArray(opacity) || !opacity.every((frame) => typeof frame === "string"))
    throw new Error("Expected string opacity keyframes");
  return opacity;
}
