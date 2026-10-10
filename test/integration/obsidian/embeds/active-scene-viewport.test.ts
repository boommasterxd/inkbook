import { describe, expect, it, vi } from "vitest";

import { readActiveSceneLayout } from "../../../../src/obsidian/embeds/active-scene-viewport";
import { readNavigationLayout } from "../../../../src/obsidian/embeds/active-editor/navigation-layout";
import type { BrowserScrollElement } from "../../../../src/obsidian/scrolling";

interface RectOptions {
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
}

function rect(options: RectOptions): DOMRect {
  return {
    bottom: options.top + options.height,
    height: options.height,
    left: options.left,
    right: options.left + options.width,
    top: options.top,
    width: options.width,
  } as DOMRect;
}

function element(
  bounds: RectOptions,
  options: {
    readonly clientHeight: number;
    readonly clientWidth: number;
    readonly document: Document;
  },
): BrowserScrollElement {
  return {
    clientHeight: options.clientHeight,
    clientWidth: options.clientWidth,
    getBoundingClientRect: () => rect(bounds),
    ownerDocument: options.document,
  } as unknown as BrowserScrollElement;
}

describe("active scene viewport", () => {
  it("clips a nested native scroll owner to the document container", () => {
    const document = { defaultView: null, scrollingElement: null } as unknown as Document;
    const container = {
      getBoundingClientRect: () => rect({ height: 2000, left: 0, top: 200, width: 1000 }),
      ownerDocument: document,
    } as unknown as HTMLElement;
    const owner = element(
      { height: 500, left: 50, top: 100, width: 800 },
      { clientHeight: 500, clientWidth: 800, document },
    );

    expect(readActiveSceneLayout(container, owner).viewport).toEqual({
      height: 400,
      left: 50,
      top: 0,
      width: 800,
    });
  });

  it("uses the owning window viewport for a document scroll owner", () => {
    const ownerWindow = { innerHeight: 700, innerWidth: 1200 } as Window;
    const documentLike = {
      defaultView: ownerWindow,
      scrollingElement: null as unknown as Element,
    };
    const document = documentLike as unknown as Document;
    const owner = element(
      { height: 700, left: 0, top: 0, width: 1100 },
      { clientHeight: 700, clientWidth: 1100, document },
    );
    const ownerRead = vi.spyOn(owner, "getBoundingClientRect");
    documentLike.scrollingElement = owner;
    const container = {
      getBoundingClientRect: () => rect({ height: 700, left: 0, top: -300, width: 1300 }),
      ownerDocument: document,
    } as unknown as HTMLElement;

    expect(readActiveSceneLayout(container, owner).viewport).toEqual({
      height: 400,
      left: 0,
      top: 300,
      width: 1100,
    });
    expect(ownerRead).not.toHaveBeenCalled();
    expect(readNavigationLayout(container, owner)?.ownerViewport).toEqual({
      bottom: 700,
      left: 0,
      right: 1100,
      top: 0,
    });
    expect(ownerRead).not.toHaveBeenCalled();
  });

  it("measures the renderer viewport from the content box", () => {
    const ownerWindow = {
      getComputedStyle: () =>
        ({
          borderBottomWidth: "1px",
          borderLeftWidth: "2px",
          borderRightWidth: "2px",
          borderTopWidth: "1px",
          paddingBottom: "9px",
          paddingLeft: "8px",
          paddingRight: "8px",
          paddingTop: "9px",
        }) as CSSStyleDeclaration,
    } as unknown as Window;
    const document = {
      defaultView: ownerWindow,
      scrollingElement: null,
    } as unknown as Document;
    const container = {
      getBoundingClientRect: () => rect({ height: 500, left: 100, top: 200, width: 1000 }),
      ownerDocument: document,
    } as unknown as HTMLElement;
    const owner = element(
      { height: 2000, left: 0, top: 0, width: 2000 },
      { clientHeight: 2000, clientWidth: 2000, document },
    );

    expect(readActiveSceneLayout(container, owner).viewport).toEqual({
      height: 480,
      left: 0,
      top: 0,
      width: 980,
    });
  });
});

function unlockViewportFixture(phase: string, blockSize = "602px") {
  let bounds = { height: 120, left: 100, top: 100, width: 700 };
  const document = {
    defaultView: {
      getComputedStyle: () => ({ borderTopWidth: "1px", borderBottomWidth: "1px" }),
    },
    scrollingElement: null,
  } as unknown as Document;
  const container = {
    getBoundingClientRect: () => rect(bounds),
    ownerDocument: document,
    style: { blockSize },
  } as unknown as HTMLElement;
  const root = { classList: { contains: (value: string) => value === phase } } as HTMLElement;
  const owner = element(
    { height: 800, left: 0, top: 0, width: 1000 },
    { clientHeight: 800, clientWidth: 1000, document },
  );
  return {
    read: () => readActiveSceneLayout(container, owner, root).viewport,
    resize: (height: number) => {
      bounds = { ...bounds, height };
    },
    scroll: (top: number) => {
      bounds = { ...bounds, top };
    },
  };
}

describe("prepared unlock viewport", () => {
  it.each(["inkbook-active-preparing", "inkbook-active-transitioning"])(
    "keeps the final content viewport stable throughout %s while honoring scrolling",
    (phase) => {
      const h = unlockViewportFixture(phase);
      for (const height of [120, 220, 360, 602]) {
        h.resize(height);
        expect(h.read()).toEqual({ height: 600, left: 0, top: 0, width: 700 });
      }
      h.scroll(-101);
      expect(h.read()).toEqual({ height: 500, left: 0, top: 100, width: 700 });
    },
  );

  it("clips the prepared extent to the native owner and uses actual height after unlock", () => {
    expect(unlockViewportFixture("inkbook-active-preparing", "2002px").read().height).toBe(699);
    expect(unlockViewportFixture("inkbook-active-ready").read().height).toBe(118);
  });

  it.each(["inkbook-active-preparing", "inkbook-active-transitioning"])(
    "covers both current and target heights during a shrinking %s",
    (phase) => {
      const h = unlockViewportFixture(phase, "202px");
      h.resize(602);
      expect(h.read().height).toBe(600);
      h.resize(402);
      expect(h.read().height).toBe(400);
      h.resize(202);
      expect(h.read().height).toBe(200);
    },
  );

  it.each(["", "auto", "100%", "NaNpx", "Infinitypx", "0px", "1px"])(
    "falls back to current geometry before a valid pixel target exists: %s",
    (blockSize) => {
      expect(unlockViewportFixture("inkbook-active-preparing", blockSize).read().height).toBe(118);
    },
  );
});
