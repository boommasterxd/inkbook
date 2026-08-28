import { expect, it } from "vitest";

import { resolveVisibleOwnerBoundary } from "../../../../src/obsidian/feedback/visible-owner-boundary";

it("clamps the boundary to the visible scroll-owner client box", () => {
  const owner = {
    clientHeight: 220,
    clientLeft: 2,
    clientTop: 3,
    clientWidth: 300,
    getBoundingClientRect: () => ({ left: 90, top: 40 }),
    parentElement: null,
    scrollHeight: 500,
  } as unknown as HTMLElement;
  const anchor = { parentElement: owner } as HTMLElement;
  const ownerDocument = {
    defaultView: { getComputedStyle: () => ({ overflowY: "auto" }) },
    documentElement: { clientHeight: 600, clientWidth: 800 },
    scrollingElement: null,
  } as unknown as Document;

  expect(resolveVisibleOwnerBoundary(anchor, ownerDocument)).toEqual({
    bottom: 263,
    left: 92,
    right: 392,
    top: 43,
  });
});

it("falls back to the owner-document viewport without a nested scroll owner", () => {
  const scrollingElement = {} as HTMLElement;
  const anchor = { parentElement: null } as HTMLElement;
  const ownerDocument = {
    defaultView: { getComputedStyle: () => ({ overflowY: "visible" }) },
    documentElement: { clientHeight: 600, clientWidth: 800 },
    scrollingElement,
  } as unknown as Document;

  expect(resolveVisibleOwnerBoundary(anchor, ownerDocument)).toEqual({
    bottom: 600,
    left: 0,
    right: 800,
    top: 0,
  });
});
