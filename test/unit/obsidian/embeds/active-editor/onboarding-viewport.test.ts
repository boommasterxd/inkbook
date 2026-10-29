// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingViewport } from "../../../../../src/obsidian/embeds/active-editor/onboarding-viewport";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture() {
  const owner = document.body.createDiv();
  const root = owner.createDiv();
  const paper = root.createDiv();
  const toolbar = root.createDiv({ cls: "inkbook-toolbar-composition" });
  Object.defineProperties(owner, {
    clientHeight: { configurable: true, value: 300 },
    clientWidth: { configurable: true, value: 700 },
    scrollHeight: { configurable: true, value: 1200 },
  });
  Object.defineProperty(toolbar, "offsetHeight", { configurable: true, value: 50 });
  owner.getBoundingClientRect = () => new DOMRect(20, 20, 700, 300);
  const visualViewport = { offsetLeft: 10, offsetTop: 0, width: 800, height: 360 };
  vi.stubGlobal("visualViewport", visualViewport);
  vi.spyOn(window, "getComputedStyle").mockReturnValue({
    paddingTop: "109px",
    paddingBottom: "86px",
  } as CSSStyleDeclaration);
  const viewport = new OnboardingViewport(root, () => owner);
  const insets = root.querySelector<HTMLElement>(".inkbook-onboarding-insets")!;
  let initialTop = 247;
  paper.getBoundingClientRect = () => new DOMRect(40, initialTop - owner.scrollTop, 580, 600);
  return {
    owner,
    paper,
    viewport,
    insets,
    visualViewport,
    setPaperTop: (top: number) => {
      initialTop = top;
    },
  };
}

describe("onboarding viewport", () => {
  it("intersects the visual viewport, safe insets and native scroll owner", () => {
    const { viewport, insets } = fixture();
    expect(viewport.read()).toEqual({ left: 20, top: 109, width: 700, height: 165 });
    viewport.dispose();
    expect(insets.isConnected).toBe(false);
  });

  it("reveals paper after opening and an orientation change without scrolling visible paper", () => {
    const { owner, paper, viewport, visualViewport, setPaperTop } = fixture();
    expect(viewport.reveal(paper)).toBe(true);
    expect(owner.scrollTop).toBe(80);
    expect(paper.getBoundingClientRect().top).toBe(167);
    expect(viewport.reveal(paper)).toBe(false);
    expect(owner.scrollTop).toBe(80);
    visualViewport.height = 375;
    setPaperTop(300);
    expect(viewport.reveal(paper)).toBe(true);
    expect(paper.getBoundingClientRect().top).toBe(167);
  });

  it("clamps the native scroll owner to its available range", () => {
    const { owner, paper, viewport, setPaperTop } = fixture();
    setPaperTop(2000);
    expect(viewport.reveal(paper)).toBe(true);
    expect(owner.scrollTop).toBe(900);
    setPaperTop(-500);
    expect(viewport.reveal(paper)).toBe(true);
    expect(owner.scrollTop).toBe(0);
    expect(viewport.reveal(paper)).toBe(false);
  });
});
