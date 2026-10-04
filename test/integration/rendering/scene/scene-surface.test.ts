// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import { PORTABLE_PALETTE_V1 } from "../../../../src/domain/schema/public";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

const scenes: SceneDom[] = [];
// Load host CSS in the test runner; the plugin has no filesystem dependency.
const hostStyles = Platform.isDesktop
  ? (await import("node:fs"))
      .readFileSync("src/obsidian/styles/inkbook.css", "utf8")
      .replace(/^@import.*$/gm, "")
  : "";

afterEach(() => {
  for (const scene of scenes.splice(0)) {
    scene.release();
    scene.toolCursor.surface.remove();
  }
  document.body.replaceChildren();
});

function fixture(ownerDocument = document) {
  installObsidianDomHelpers();
  const container = ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  container.className = "inkbook-root";
  const style = ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "style");
  style.textContent = hostStyles;
  ownerDocument.body.append(style);
  ownerDocument.body.append(container);
  const pointerdown = vi.fn();
  const scene = new SceneDom(container, "Canvas", { pointerdown });
  scenes.push(scene);
  const host = container.firstElementChild as HTMLDivElement;
  return { container: container as HTMLDivElement, host, pointerdown, scene };
}

describe("isolated scene surface", () => {
  it("isolates retained SVG selectors while input stays on the accessible light DOM surface", () => {
    const { container, host, pointerdown, scene } = fixture();
    expect(host.shadowRoot?.mode).toBe("open");
    expect(host.shadowRoot?.firstElementChild).toBe(scene.svg);
    expect(container.querySelector("svg")).toBeNull();
    expect(scene.inputSurface.parentElement).toBe(container);
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
  });

  it("owns its surface in the supplied presentation document", () => {
    const other = document.implementation.createHTMLDocument("Pop-out");
    const { container, host, scene } = fixture(other);
    expect(host.ownerDocument).toBe(other);
    expect(scene.svg.ownerDocument).toBe(other);
    expect(scene.inputSurface.ownerDocument).toBe(other);
    scene.release();
    expect(container.children).toHaveLength(0);
  });

  it("hides only foreground and input while preparing and restores both when ready", () => {
    const { container, host, scene } = fixture();
    for (const preparing of [true, false]) {
      container.classList.toggle("inkbook-active-preparing", preparing);
      const expected = preparing ? "hidden" : "visible";
      expect(getComputedStyle(scene.contentGroup).visibility).toBe(expected);
      expect(getComputedStyle(scene.inputSurface).visibility || "visible").toBe(expected);
      expect(getComputedStyle(scene.pageSurface).visibility).not.toBe("hidden");
      expect(getComputedStyle(host).blockSize).toBe("100%");
    }
    container.classList.add("inkbook-active-transitioning");
    container.setCssProps({ "--inkbook-active-scene-block-size": "902px" });
    expect(getComputedStyle(scene.contentGroup).visibility).toBe("visible");
  });

  it("keeps selection and motion styles local while inheriting chrome theme tokens", () => {
    const { container, scene } = fixture();
    container.setCssProps({ "--interactive-accent": "#123456", "--text-normal": "#654321" });
    const trace = scene.pageSurface.cloneNode(false) as SVGPathElement;
    trace.setAttribute("class", "inkbook-selection-center-trace");
    trace.setAttribute("data-inkbook-motion", "erase");
    scene.selectionTraceGroup.append(trace);
    expect(getComputedStyle(trace).stroke).toBe("#123456");
    expect(getComputedStyle(trace).fill).toBe("none");
    expect(getComputedStyle(trace).strokeWidth).toBe("1.5");
    expect(getComputedStyle(trace).transformBox).toBe("fill-box");
    expect(getComputedStyle(scene.selectionHandlePath).fill).toBe("#123456");
    expect(getComputedStyle(scene.overlayPath).strokeDasharray).toBe("3 3");
    scene.selectionOverlayPath.setAttribute("data-center-outline", "true");
    scene.selectionOverlayPath.setAttribute("data-selection-fill", "none");
    expect(getComputedStyle(scene.selectionOverlayPath).stroke).toBe("none");
    expect(getComputedStyle(scene.selectionOverlayPath).fill).toBe("none");
    const outsideStyle = document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    outsideStyle.textContent = ".inkbook-root path { stroke: red !important; }";
    container.append(outsideStyle);
    expect(getComputedStyle(trace).stroke).toBe("#123456");
    const style = scene.svg.querySelector("style") as unknown as HTMLStyleElement;
    const erase = [...style.sheet!.cssRules].find(
      (rule) => rule instanceof CSSKeyframesRule && rule.name === "inkbook-element-erase",
    ) as CSSKeyframesRule;
    expect([...erase.cssRules].map((rule) => (rule as CSSKeyframeRule).style.opacity)).toEqual([
      "",
      "0",
    ]);
  });
});
