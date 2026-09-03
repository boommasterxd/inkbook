import { describe, expect, it } from "vitest";

import { readActiveSceneViewport } from "../../../../src/obsidian/embeds/active-scene-viewport";
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

    expect(readActiveSceneViewport(container, owner)).toEqual({
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
    documentLike.scrollingElement = owner;
    const container = {
      getBoundingClientRect: () => rect({ height: 700, left: 0, top: -300, width: 1000 }),
      ownerDocument: document,
    } as unknown as HTMLElement;

    expect(readActiveSceneViewport(container, owner)).toEqual({
      height: 400,
      left: 0,
      top: 300,
      width: 1000,
    });
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

    expect(readActiveSceneViewport(container, owner)).toEqual({
      height: 480,
      left: 0,
      top: 0,
      width: 980,
    });
  });
});
