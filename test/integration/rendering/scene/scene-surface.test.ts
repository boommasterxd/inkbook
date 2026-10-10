// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { SceneSurface } from "../../../../src/rendering/scene/scene-surface";
import { SVG_NAMESPACE } from "../../../../src/rendering/scene/constants";
import { PORTABLE_PALETTE_V1 } from "../../../../src/domain/schema/public";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { sceneSurfaceZoomFixture } from "../../../fixtures/rendering/scene-surface-zoom";

const scenes: SceneDom[] = [];
const surfaces: SceneSurface[] = [];
// Load host CSS in the test runner; the plugin has no filesystem dependency.
const hostStyles = Platform.isDesktop
  ? (await import("node:fs"))
      .readFileSync("src/obsidian/styles/inkbook.css", "utf8")
      .replace(/^@import.*$/gm, "")
  : "";

afterEach(() => {
  for (const surface of surfaces.splice(0)) surface.release();
  for (const scene of scenes.splice(0)) {
    scene.release();
    scene.toolCursor.surface.remove();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture(
  ownerDocument = document,
  options: {
    readonly nested?: boolean;
    readonly preparing?: boolean;
    readonly onFailure?: () => void;
  } = {},
) {
  installObsidianDomHelpers();
  const root = ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  root.className = "inkbook-root";
  root.classList.toggle("inkbook-active-preparing", options.preparing ?? false);
  const container = options.nested
    ? ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div")
    : root;
  if (options.nested) {
    const chrome = ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
    chrome.className = "inkbook-editor-chrome";
    container.className = "inkbook-background-container";
    root.append(chrome);
    chrome.append(container);
  }
  const style = ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "style");
  style.textContent = hostStyles;
  ownerDocument.body.append(style);
  ownerDocument.body.append(root);
  const pointerdown = vi.fn();
  const ownerWindow = ownerDocument.defaultView!;
  const readStyle = ownerWindow.getComputedStyle.bind(ownerWindow);
  // Happy DOM resolves inherited var() references but omits inherited custom
  // properties from getPropertyValue(); supply that browser boundary explicitly.
  vi.spyOn(ownerWindow, "getComputedStyle").mockImplementation((element) => {
    const style = readStyle(element);
    if (element.parentElement !== container || element.getAttribute("class") !== "inkbook-scene")
      return style;
    return new Proxy(style, {
      get: (target, property) =>
        property === "getPropertyValue"
          ? (name: string) =>
              target.getPropertyValue(name) || readStyle(root).getPropertyValue(name)
          : (Reflect.get(target, property) as unknown),
    });
  });
  const scene = SceneDom.create({
    container,
    accessibleName: "Canvas",
    inputHandlers: { pointerdown },
    surfaceThemeRoot: root,
    ...(options.onFailure === undefined ? {} : { onSurfaceFailure: options.onFailure }),
  });
  scenes.push(scene);
  const host = container.firstElementChild as HTMLDivElement;
  return { container: container as HTMLDivElement, root, host, pointerdown, scene };
}

function surfaceFixture() {
  const container = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  document.body.append(container);
  const invalidate = vi.fn();
  const failure = vi.fn();
  const surface = new SceneSurface(container, invalidate, { onFailure: failure });
  surfaces.push(surface);
  return { container, invalidate, failure, surface };
}

describe("isolated scene surface", () => {
  it("isolates retained SVG selectors while input stays on the accessible light DOM surface", () => {
    const { container, host, pointerdown, scene } = fixture();
    expect(host.shadowRoot?.mode).toBe("open");
    const frame = host.shadowRoot?.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.localName).toBe("iframe");
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(frame.tabIndex).toBe(-1);
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    expect(frame.contentDocument?.body.firstElementChild).toBe(scene.svg);
    expect(scene.svg.ownerDocument).toBe(frame.contentDocument);
    expect(container.querySelector("svg")).toBeNull();
    expect(scene.inputSurface.parentElement).toBe(container);
    expect(scene.inputSurface.ownerDocument).toBe(document);
    expect(scene.toolCursor.surface.ownerDocument).toBe(document);
    expect(scene.inputSurface.getAttribute("role")).toBe("application");
    scene.inputSurface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(pointerdown).toHaveBeenCalledOnce();
    scene.release();
    expect(container.children).toHaveLength(0);
    expect(host.shadowRoot?.children).toHaveLength(0);
    expect(scene.svg.isConnected).toBe(false);
    scene.inputSurface.dispatchEvent(new PointerEvent("pointerdown"));
    expect(pointerdown).toHaveBeenCalledOnce();
    scene.release();
  });
});

describe("scene presentation documents and foreground", () => {
  it("retains the canonical palette and scene geometry across theme changes", () => {
    const { scene } = fixture();
    scene.setPageHeight(900);
    const geometry = scene.pageSurface.getAttribute("d");
    for (const scheme of ["dark", "light"] as const) {
      scene.setScheme(scheme);
      expect(scene.svg.style.getPropertyValue("--inkbook-page")).toBe(
        PORTABLE_PALETTE_V1[scheme].page,
      );
      expect(scene.svg.style.getPropertyValue("--inkbook-text")).toBe(
        PORTABLE_PALETTE_V1[scheme].text,
      );
      expect(scene.svg.style.colorScheme).toBe(scheme);
      expect(scene.pageSurface.getAttribute("d")).toBe(geometry);
    }
    expect(scene.svg.querySelectorAll("style")).toHaveLength(1);
    expect(scene.svg.getAttribute("width")).toBe("100%");
    expect(scene.svg.getAttribute("height")).toBe("100%");
    expect(scene.svg.hasAttribute("viewBox")).toBe(false);
  });

  it("owns its surface in the supplied presentation document", () => {
    const parentFrame = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "iframe",
    ) as HTMLIFrameElement;
    document.body.append(parentFrame);
    const other = parentFrame.contentDocument!;
    const { container, host, scene } = fixture(other);
    expect(host.ownerDocument).toBe(other);
    expect(scene.svg.ownerDocument).not.toBe(other);
    expect(scene.inputSurface.ownerDocument).toBe(other);
    expect(scene.toolCursor.surface.ownerDocument).toBe(other);
    expect(scene.svg.ownerDocument.defaultView).not.toBe(other.defaultView);
    scene.release();
    expect(container.children).toHaveLength(0);
  });

  it("hides only foreground and input while preparing and restores both when ready", () => {
    const { container, host, scene } = fixture();
    for (const preparing of [true, false]) {
      container.classList.toggle("inkbook-active-preparing", preparing);
      synchronize(scene);
      const expected = preparing ? "hidden" : "visible";
      expect(
        scene.svg.ownerDocument.body.style.getPropertyValue(
          "--inkbook-scene-foreground-visibility",
        ),
      ).toBe(expected);
      expect(drawingStyle(scene.contentGroup).visibility).toBe(expected);
      expect(getComputedStyle(scene.inputSurface).visibility || "visible").toBe(expected);
      expect(drawingStyle(scene.pageSurface).visibility).not.toBe("hidden");
      expect(getComputedStyle(host).blockSize).toBe("100%");
    }
    container.classList.add("inkbook-active-transitioning");
    container.setCssProps({ "--inkbook-active-scene-block-size": "902px" });
    synchronize(scene);
    expect(drawingStyle(scene.contentGroup).visibility).toBe("visible");
  });
});

describe("scene theme and local presentation styles", () => {
  it("keeps selection and motion styles local while inheriting chrome theme tokens", () => {
    const { container, scene } = fixture();
    container.setCssProps({ "--interactive-accent": "#123456", "--text-normal": "#654321" });
    synchronize(scene);
    expect(scene.svg.ownerDocument.body.style.getPropertyValue("--interactive-accent")).toBe(
      "#123456",
    );
    const trace = scene.pageSurface.cloneNode(false) as SVGPathElement;
    trace.setAttribute("class", "inkbook-selection-center-trace");
    trace.setAttribute("data-inkbook-motion", "erase");
    scene.selectionTraceGroup.append(trace);
    expect(drawingStyle(trace).stroke).toBe("#123456");
    expect(drawingStyle(trace).fill).toBe("none");
    expect(drawingStyle(trace).strokeWidth).toBe("1.5");
    expect(drawingStyle(trace).transformBox).toBe("fill-box");
    expect(drawingStyle(scene.selectionHandlePath).fill).toBe("#123456");
    expect(drawingStyle(scene.overlayPath).strokeDasharray).toBe("3 3");
    scene.selectionOverlayPath.setAttribute("data-center-outline", "true");
    scene.selectionOverlayPath.setAttribute("data-selection-fill", "none");
    expect(drawingStyle(scene.selectionOverlayPath).stroke).toBe("none");
    expect(drawingStyle(scene.selectionOverlayPath).fill).toBe("none");
    const outsideStyle = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    outsideStyle.textContent = ".inkbook-root path { stroke: red !important; }";
    container.append(outsideStyle);
    expect(drawingStyle(trace).stroke).toBe("#123456");
    container.setCssProps({ "--interactive-accent": "#abcdef", "--text-normal": "#fedcba" });
    synchronize(scene);
    expect(drawingStyle(trace).stroke).toBe("#abcdef");
    expect(scene.svg.ownerDocument.body.style.getPropertyValue("--text-normal")).toBe("#fedcba");
    expect(scene.svg.ownerDocument.body.style.getPropertyValue("--inkbook-page")).toBe("");
    const style = scene.svg.querySelector("style") as unknown as HTMLStyleElement;
    const erase = [...style.sheet!.cssRules].find(
      (rule) => "name" in rule && rule.name === "inkbook-element-erase",
    ) as CSSKeyframesRule;
    expect([...erase.cssRules].map((rule) => (rule as CSSKeyframeRule).style.opacity)).toEqual([
      "",
      "0",
    ]);
  });
});

it("invalidates each foreign theme change while coalescing reads and preserving owned zoom", () => {
  const h = sceneSurfaceZoomFixture();
  const initialVersion = h.renderer.layoutInvalidationVersion;
  try {
    h.foreignStyle(h.container, "padding-top", "12px");
    h.deliver();
    expect(h.renderer.layoutInvalidationVersion).toBe(initialVersion + 1);
    h.foreignClass(h.root);
    h.deliver();
    expect(h.renderer.layoutInvalidationVersion).toBe(initialVersion + 2);
    h.renderer.setScheme("light");
    h.renderer.setScheme("light");
    expect(h.renderer.layoutInvalidationVersion).toBe(initialVersion + 4);
    expect(h.read).not.toHaveBeenCalled();
    expect(h.scheduler.pendingCount).toBe(1);
    h.scheduler.runAll();
    expect(h.read).toHaveBeenCalledOnce();
    h.read.mockClear();
    h.zoom(200);
    h.zoom(300);
    h.deliver();
    expect(h.renderer.layoutInvalidationVersion).toBe(initialVersion + 4);
    expect(h.scheduler.pendingCount).toBe(0);
    h.resize(300);
    h.scheduler.runAll();
    expect(h.renderer.layoutInvalidationVersion).toBe(initialVersion + 4);
    expect(h.read).not.toHaveBeenCalled();
  } finally {
    h.release();
  }
});

describe("scene observer work and cleanup", () => {
  it("writes only changed fractional content sizes and bridged tokens in the central write phase", () => {
    let resize: ResizeObserverCallback = () => undefined;
    let mutation: MutationCallback = () => undefined;
    const observed: Node[] = [];
    const disconnectResize = vi.fn();
    const disconnectTheme = vi.fn();
    vi.spyOn(window, "ResizeObserver").mockImplementation(
      class {
        public constructor(callback: ResizeObserverCallback) {
          resize = callback;
        }
        public observe = vi.fn();
        public disconnect = disconnectResize;
      } as unknown as typeof ResizeObserver,
    );
    vi.spyOn(window, "MutationObserver").mockImplementation(
      class {
        public constructor(callback: MutationCallback) {
          mutation = callback;
        }
        public observe(target: Node, options: MutationObserverInit): void {
          observed.push(target);
          expect(options).toEqual({
            attributes: true,
            attributeOldValue: true,
            attributeFilter: ["class", "style"],
          });
        }
        public disconnect = disconnectTheme;
      } as unknown as typeof MutationObserver,
    );
    const { container, invalidate, failure, surface } = surfaceFixture();
    const drawingDocument = surface.drawingDocument;
    const body = drawingDocument.body;
    surface.read();
    surface.write();
    expect(new Set(observed)).toEqual(
      new Set([container, document.body, document.documentElement]),
    );
    const styleWrites = vi.spyOn(body.style, "setProperty");
    const propertyWrites = (property: string) =>
      styleWrites.mock.calls.filter(([name]) => name === property).length;
    const hostReads = vi.spyOn(window, "getComputedStyle");
    const entry: ResizeObserverEntry = {
      target: surface.host,
      contentRect: new DOMRectReadOnly(0, 0, 200.625, 999.375),
      borderBoxSize: [{ inlineSize: 200.625, blockSize: 999.375 }],
      contentBoxSize: [{ inlineSize: 200.625, blockSize: 999.375 }],
      devicePixelContentBoxSize: [{ inlineSize: 200.625, blockSize: 999.375 }],
    };
    resize([entry], {} as ResizeObserver);
    resize([entry], {} as ResizeObserver);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
    expect(propertyWrites("width")).toBe(0);
    expect(hostReads).not.toHaveBeenCalled();
    surface.read();
    surface.write();
    expect(body.style.width).toBe("200.625px");
    expect(body.style.height).toBe("999.375px");
    expect(propertyWrites("width")).toBe(1);
    expect(propertyWrites("height")).toBe(1);
    mutation([], {} as MutationObserver);
    mutation([], {} as MutationObserver);
    expect(invalidate.mock.calls).toEqual([[], [true], [true]]);
    surface.read();
    surface.write();
    expect(hostReads).toHaveBeenCalledTimes(1);
    expect(styleWrites.mock.calls.filter(([name]) => name.startsWith("--"))).toHaveLength(0);
    expect(propertyWrites("width")).toBe(1);
    expect(surface.drawingDocument).toBe(drawingDocument);
    surface.release();
    surface.release();
    resize([entry], {} as ResizeObserver);
    mutation([], {} as MutationObserver);
    surface.read();
    surface.write();
    expect(disconnectResize).toHaveBeenCalledTimes(1);
    expect(disconnectTheme).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(failure).not.toHaveBeenCalled();
  });
});

describe("scene document lifecycle failures", () => {
  it("preserves the initial load document and fails closed on an unexpected document replacement", () => {
    const { container, invalidate, failure, surface } = surfaceFixture();
    const frame = surface.host.shadowRoot!.querySelector("iframe") as HTMLIFrameElement;
    const svg = surface.drawingDocument.createElementNS(SVG_NAMESPACE, "svg");
    expect(() => surface.attach(document.createElementNS(SVG_NAMESPACE, "svg"))).toThrow(
      "drawing document",
    );
    surface.attach(svg);
    surface.read();
    surface.write();
    frame.dispatchEvent(new Event("load"));
    expect(svg.ownerDocument).toBe(surface.drawingDocument);
    expect(svg.parentElement).toBe(surface.drawingDocument.body);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(failure).not.toHaveBeenCalled();
    Object.defineProperty(frame, "contentDocument", { value: null });
    frame.dispatchEvent(new Event("load"));
    expect(container.children).toHaveLength(0);
    expect(surface.drawingDocument.body.children).toHaveLength(0);
    frame.dispatchEvent(new Event("load"));
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(failure).toHaveBeenCalledTimes(1);
  });

  it("removes constructor-owned DOM when no drawing document is available", () => {
    const container = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
    const create = document.createElementNS.bind(document);
    vi.spyOn(document, "createElementNS").mockImplementation((namespace, name) => {
      const node = create(namespace, name);
      if (name === "iframe") Object.defineProperty(node, "contentDocument", { value: null });
      return node;
    });
    expect(() => new SceneSurface(container, vi.fn())).toThrow("attached presentation document");
    expect(container.children).toHaveLength(0);
  });
});

describe("owned root publication and input failure", () => {
  it("keeps nested foreground hidden initially and reveals it in the handoff without a host style read", async () => {
    const { root, container, host, scene } = fixture(document, { nested: true, preparing: true });
    expect(container.parentElement?.className).toBe("inkbook-editor-chrome");
    expect(container.parentElement?.parentElement).toBe(root);
    expect(host.parentElement).toBe(container);
    const body = scene.svg.ownerDocument.body;
    const foreground = "--inkbook-scene-foreground-visibility";
    expect(body.style.getPropertyValue(foreground)).toBe("hidden");
    expect(drawingStyle(scene.contentGroup).visibility).toBe("hidden");
    const reads = vi.spyOn(window, "getComputedStyle");
    reads.mockClear();
    const invalidated = new Promise<void>((resolve) => {
      scene.onSurfaceInvalidated = () => resolve();
    });
    root.classList.remove("inkbook-active-preparing");
    scene.revealSurface();
    expect(reads).not.toHaveBeenCalled();
    expect(body.style.getPropertyValue(foreground)).toBe("visible");
    expect(drawingStyle(scene.contentGroup).visibility).toBe("visible");
    await invalidated;
    scene.readSurface();
    scene.writeSurface();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(body.style.getPropertyValue(foreground)).toBe("visible");
  });

  it("removes input listeners and disables the parent input before reporting document replacement", () => {
    const failure = vi.fn();
    const { scene, host, container, pointerdown } = fixture(document, { onFailure: failure });
    failure.mockImplementation(() => {
      expect(scene.inputSurface.hasAttribute("inert")).toBe(true);
      expect(scene.inputSurface.tabIndex).toBe(-1);
      expect(scene.inputSurface.isConnected).toBe(false);
      scene.inputSurface.dispatchEvent(new PointerEvent("pointerdown"));
      expect(pointerdown).not.toHaveBeenCalled();
    });
    const frame = host.shadowRoot!.querySelector("iframe") as HTMLIFrameElement;
    Object.defineProperty(frame, "contentDocument", { value: null });
    frame.dispatchEvent(new Event("load"));
    frame.dispatchEvent(new Event("load"));
    expect(failure).toHaveBeenCalledTimes(1);
    expect(container.children).toHaveLength(0);
    scene.release();
    expect(failure).toHaveBeenCalledTimes(1);
  });
});

function synchronize(scene: SceneDom): void {
  scene.invalidateSurfaceTheme();
  scene.readSurface();
  scene.writeSurface();
}

function drawingStyle(element: Element): CSSStyleDeclaration {
  return element.ownerDocument.defaultView!.getComputedStyle(element);
}
