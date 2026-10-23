// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { StaticPreviewSurface } from "../../../../src/rendering/scene/static-preview-surface";
import { SVG_NAMESPACE } from "../../../../src/rendering/scene/constants";

const surfaces: StaticPreviewSurface[] = [];

afterEach(() => {
  for (const surface of surfaces.splice(0)) surface.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture(connected = true) {
  const container = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  if (connected) document.body.append(container);
  const surface = new StaticPreviewSurface(container);
  surfaces.push(surface);
  const frame = container.shadowRoot!.querySelector("iframe")!;
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  // Happy DOM otherwise makes the first adopted document permanently non-configurable.
  Object.defineProperty(svg, "ownerDocument", { configurable: true, value: document });
  svg.classList.add("inkbook-locked-preview-svg");
  svg.setAttribute("viewBox", "0 0 2048.6 300");
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("class", "inkbook-theme-page");
  path.setAttribute("d", "M 0 0 H 2048.6 V 300 H 0 Z");
  svg.append(path);
  return { container, surface, frame, svg };
}

describe("static preview document ownership", () => {
  it("mounts the retained drawing in an isolated inert document without another input target", async () => {
    const { container, surface, frame, svg } = fixture();
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.hasAttribute("inert")).toBe(true);
    expect(frame.tabIndex).toBe(-1);
    expect(frame.hasAttribute("src")).toBe(false);
    expect(frame.hasAttribute("srcdoc")).toBe(false);
    surface.setSvg(svg);
    await surface.ensureMounted();
    expect(svg.ownerDocument).toBe(surface.drawingDocument);
    expect(svg.parentNode).toBe(frame.contentDocument!.body);
    expect(container.querySelector("svg")).toBeNull();
  });

  it("retains the same drawing and stylesheet without repeated writes during refresh and theme reuse", async () => {
    const { surface, frame, svg } = fixture();
    surface.setSvg(svg);
    const drawingDocument = surface.drawingDocument!;
    const replace = vi.spyOn(drawingDocument.body, "replaceChildren");
    const stylesheet = drawingDocument.head.lastElementChild;
    const writes = vi.spyOn(drawingDocument.documentElement, "setAttribute");
    surface.refresh();
    surface.setSvg(svg);
    frame.dispatchEvent(new Event("load"));
    surface.setColorScheme("dark");
    surface.setColorScheme("dark");
    surface.setColorScheme("light");
    await surface.ensureMounted();
    expect(drawingDocument.documentElement.dataset.inkbookScheme).toBe("light");
    expect(drawingDocument.head.lastElementChild).toBe(stylesheet);
    expect(drawingDocument.body.firstElementChild).toBe(svg);
    expect(replace).not.toHaveBeenCalled();
    expect(writes.mock.calls).toEqual([
      ["data-inkbook-scheme", "dark"],
      ["data-inkbook-scheme", "light"],
    ]);
  });

  it("stages detached content and remounts the same drawing when the native frame document changes", async () => {
    const { container, surface, frame, svg } = fixture(false);
    surface.setColorScheme("dark");
    surface.setSvg(svg);
    expect(surface.drawingDocument).toBeUndefined();
    expect(svg.parentNode).toBeNull();
    const mounted = surface.ensureMounted();
    document.body.append(container);
    frame.dispatchEvent(new Event("load"));
    await mounted;
    const previousDocument = surface.drawingDocument!;
    const replacement = document.implementation.createHTMLDocument();
    Object.defineProperty(frame, "contentDocument", { configurable: true, value: replacement });
    frame.dispatchEvent(new Event("load"));
    await surface.ensureMounted();
    expect(surface.drawingDocument).toBe(replacement);
    expect(svg.ownerDocument).toBe(replacement);
    expect(replacement.body.firstElementChild).toBe(svg);
    expect(replacement.documentElement.dataset.inkbookScheme).toBe("dark");
    expect(previousDocument.head.querySelectorAll("style")).toHaveLength(0);
    expect(previousDocument.body.children).toHaveLength(0);
  });

  it("cleans pending readiness and native listeners on cancellation and disposal", async () => {
    const { container, surface, frame, svg } = fixture(false);
    surface.setSvg(svg);
    const abort = new AbortController();
    const removeAbort = vi.spyOn(abort.signal, "removeEventListener");
    const cancelled = expect(surface.ensureMounted(abort.signal)).rejects.toThrow("cancelled");
    abort.abort(new Error("cancelled"));
    await cancelled;
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    const removeLoad = vi.spyOn(frame, "removeEventListener");
    const disposed = expect(surface.ensureMounted()).rejects.toThrow("disposed");
    surface.dispose();
    surface.dispose();
    await disposed;
    expect(removeLoad).toHaveBeenCalledOnce();
    expect(container.shadowRoot!.children).toHaveLength(0);
    expect(surface.drawingDocument).toBeUndefined();
    document.body.append(container);
    frame.dispatchEvent(new Event("load"));
    expect(svg.isConnected).toBe(false);
    await expect(surface.ensureMounted()).rejects.toThrow("disposed");
  });
});
