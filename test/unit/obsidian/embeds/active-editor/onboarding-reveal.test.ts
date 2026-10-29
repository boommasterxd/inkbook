// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OnboardingCoach } from "../../../../../src/obsidian/embeds/active-editor/onboarding-coach";
import { ONBOARDING_STEPS } from "../../../../../src/obsidian/embeds/active-editor/onboarding-steps";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixture(scrollHeight = 1200) {
  const owner = document.body.createDiv();
  const root = owner.createDiv();
  root.dataset.inkbookMotion = "reduced";
  const paper = root.createDiv({ cls: "inkbook-background-container" });
  const toolbar = root.createDiv({ cls: "inkbook-toolbar-composition" });
  const target = toolbar.createEl("button");
  target.dataset.inkbookAction = "draw";
  let targetOffset = 58;
  target.getBoundingClientRect = () =>
    new DOMRect(
      200,
      paper.getBoundingClientRect().top - targetOffset,
      44,
      targetOffset === 60 ? 48 : 44,
    );
  paper.getBoundingClientRect = () =>
    new DOMRect(40, (scrollHeight > 360 ? 300 : 250) - owner.scrollTop, 580, 600);
  owner.getBoundingClientRect = () => new DOMRect(0, 0, 800, 360);
  Object.defineProperties(owner, {
    clientHeight: { configurable: true, value: 360 },
    clientWidth: { configurable: true, value: 800 },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
  Object.defineProperty(toolbar, "offsetHeight", { configurable: true, value: 50 });
  owner.scrollTop = scrollHeight > 360 ? 139 : 0;
  vi.stubGlobal(
    "visualViewport",
    Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: 800, height: 360 }),
  );
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) =>
    element.classList.contains("inkbook-onboarding-insets")
      ? ({ paddingTop: "103px", paddingBottom: "86px" } as CSSStyleDeclaration)
      : computed(element),
  );
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const workScheduler = workSchedulerFromFrames({
    requestAnimationFrame: (callback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  const coach = new OnboardingCoach({
    root,
    workScheduler,
    scrollOwner: () => owner,
    onClose: vi.fn(),
    onNavigate: vi.fn(),
  });
  coach.show(
    ONBOARDING_STEPS.find((step) => step.action === "draw")!,
    0,
    1,
  );
  const note = root.querySelector<HTMLElement>(".inkbook-onboarding-note")!;
  const navigation = root.querySelector<HTMLElement>(".inkbook-onboarding-navigation")!;
  Object.defineProperty(note, "offsetHeight", { configurable: true, value: 44 });
  Object.defineProperty(navigation, "offsetHeight", { configurable: true, value: 48 });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((frame) => frame(0));
  };
  return {
    owner,
    paper,
    root,
    coach,
    note,
    navigation,
    frames,
    flush,
    target,
    setTargetOffset: (offset: number) => {
      targetOffset = offset;
    },
  };
}

it("reveals a taller contextual target clipped above the safe viewport", () => {
  const current = fixture();
  window.dispatchEvent(new Event("resize"));
  current.flush();
  current.setTargetOffset(60);
  expect(current.target.getBoundingClientRect().top).toBe(101);
  current.owner.dispatchEvent(new Event("scroll", { bubbles: true }));
  current.flush();
  expect(current.paper.getBoundingClientRect().top).toBe(163);
  current.flush();
  const target = current.target.getBoundingClientRect();
  expect(target.top).toBe(103);
  expect(target.bottom).toBeLessThanOrEqual(274);
  expectTextAndNavigationVisible(current);
  expect(current.frames.size).toBe(0);
  current.coach.dispose();
});

function expectGuideVisible(current: ReturnType<typeof fixture>): void {
  expectTextAndNavigationVisible(current);
  expect(
    current.root.querySelector<SVGSVGElement>(".inkbook-onboarding-arrow")?.style.visibility,
  ).toBe("visible");
}

function expectTextAndNavigationVisible(current: ReturnType<typeof fixture>): void {
  expect(current.note.style.visibility).toBe("visible");
  expect(current.navigation.style.visibility).toBe("visible");
}

it.each([208, 87])("recovers guidance after the native anchor moves paper to %s", (paperTop) => {
  const current = fixture();
  window.dispatchEvent(new Event("resize"));
  current.flush();
  expectGuideVisible(current);
  current.owner.scrollTop = 300 - paperTop;
  current.owner.dispatchEvent(new Event("scroll", { bubbles: true }));
  current.flush();
  expect(current.paper.getBoundingClientRect().top).toBe(161);
  expect(current.frames.size).toBe(1);
  current.flush();
  expectGuideVisible(current);
  expect(Number.parseFloat(current.note.style.top) + 44).toBeLessThanOrEqual(
    Number.parseFloat(current.navigation.style.top),
  );
  expect(current.frames.size).toBe(0);
  current.coach.dispose();
  expect(current.root.querySelector(".inkbook-onboarding-insets")).toBeNull();
  current.owner.dispatchEvent(new Event("scroll", { bubbles: true }));
  expect(current.frames.size).toBe(0);
});

it("does not retry indefinitely when the native scroll owner cannot move", () => {
  const current = fixture(360);
  current.owner.dispatchEvent(new Event("scroll", { bubbles: true }));
  current.flush();
  expect(current.owner.scrollTop).toBe(0);
  expect(current.note.style.visibility).toBe("hidden");
  expect(current.frames.size).toBe(0);
  current.coach.dispose();
});

it.each(["wheel", "touch", "PageDown"])(
  "respects deliberate %s scrolling until a resize",
  (input) => {
    const current = fixture();
    window.dispatchEvent(new Event("resize"));
    current.flush();
    expect(current.note.style.visibility).toBe("visible");
    const event =
      input === "wheel"
        ? new WheelEvent("wheel", { bubbles: true, deltaY: 30 })
        : input === "touch"
          ? new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })
          : new KeyboardEvent("keydown", { bubbles: true, key: input });
    current.note.dispatchEvent(event);
    for (const scrollTop of [120, 92]) {
      current.owner.scrollTop = scrollTop;
      current.owner.dispatchEvent(new Event("scroll", { bubbles: true }));
      current.flush();
      expect(current.owner.scrollTop).toBe(scrollTop);
      expect(current.frames.size).toBe(0);
    }
    expect(current.note.style.visibility).toBe("hidden");
    window.dispatchEvent(new Event("resize"));
    current.flush();
    expect(current.paper.getBoundingClientRect().top).toBe(161);
    expectTextAndNavigationVisible(current);
    expect(current.frames.size).toBe(0);
    current.coach.dispose();
  },
);
