import { expect, it, vi } from "vitest";
import { ActiveScenePreviewHandoff } from "../../../../../src/obsidian/embeds/active-scene/active-scene-handoff";
import { PresentationEntrance } from "../../../../../src/obsidian/embeds/presentation/presentation-entrance";
import { SvgSceneRenderer } from "../../../../../src/rendering/scene";
import { NAVIGATION_PAGE } from "../../../../fixtures/rendering/pressure-navigation";
import { FakeClassList } from "../../../../fixtures/obsidian/class-list";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
  fakeNode,
} from "../../../../unit/rendering/scene/fakes";

function fixture(mode: "full" | "reduced" | "system" | "initial", activeHeight = 640) {
  const scheduler = new FakeScheduler();
  const document = new FakeDocument();
  const classes = new FakeClassList();
  const root = asElement(Object.assign(new FakeNode(document, "div"), { classList: classes }));
  const wrapper = new FakeNode(document, "div");
  const container = Object.assign(new FakeNode(document, "div"), {
    classList: new FakeClassList(),
  });
  fakeNode(root).append(wrapper);
  wrapper.append(container);
  const read = vi.fn(() => ({
    width: "512.5px",
    height: `${String(activeHeight)}px`,
    getPropertyValue: (name: string) => {
      if (name !== "--inkbook-scene-foreground-visibility") return "";
      return classes.contains("inkbook-active-preparing") ? "hidden" : "visible";
    },
  }));
  const ownerWindow = {
    getComputedStyle: read,
    setTimeout: vi.fn(() => 1),
    clearTimeout: vi.fn(),
  } as unknown as Window;
  Object.defineProperty(document, "defaultView", { value: ownerWindow });
  let drawing: FakeDocument | undefined;
  let hidden = false;
  const preview = {
    classList: new FakeClassList(),
    ownerDocument: document,
    getBoundingClientRect: () => ({ height: 96 }),
    get hidden() {
      return hidden;
    },
    set hidden(value: boolean) {
      if (value) {
        expect(drawing?.body.style.getPropertyValue("--inkbook-scene-foreground-visibility")).toBe(
          "visible",
        );
      }
      hidden = value;
    },
    remove: vi.fn(),
    style: { removeProperty: vi.fn() },
  } as unknown as HTMLElement;
  const entrance =
    mode === "initial"
      ? new PresentationEntrance({
          workScheduler: scheduler.workScheduler,
          motion: () => "full",
          onPresented: vi.fn(),
          ownerWindow,
          preview,
          root,
        })
      : undefined;
  entrance?.prepare();
  entrance?.holdForActivation();
  const stabilize = vi.fn(() => {
    expect(classes.contains("inkbook-active-preparing")).toBe(true);
    expect(preview.hidden).toBe(false);
    return vi.fn();
  });
  const handoff = new ActiveScenePreviewHandoff({
    workScheduler: scheduler.workScheduler,
    beginScrollStability: stabilize,
    container: asElement(container),
    motion: mode === "initial" ? "full" : mode,
    ...(entrance === undefined ? {} : { initialEntrance: entrance }),
    preview,
    root,
  });
  const renderer = new SvgSceneRenderer({
    container: asElement(container),
    surfaceThemeRoot: root,
    layout: { readViewport: () => ({ height: 100, left: 0, top: 0, width: 100 }) },
    page: NAVIGATION_PAGE,
    store: new FakeSceneStore(),
    workScheduler: scheduler.workScheduler,
  });
  drawing = fakeNode(renderer.svg).ownerDocument;
  handoff.onSceneReveal = renderer.revealSurface;
  scheduler.runAll();
  container.style.blockSize = `${String(activeHeight)}px`;
  return { renderer, handoff, entrance, scheduler, drawing, read, preview, classes, stabilize };
}

it.each(["full", "reduced", "system", "initial"] as const)(
  "reveals child foreground before replacing the preview with %s motion",
  (mode) => {
    const h = fixture(mode);
    try {
      expect(h.drawing.body.style.getPropertyValue("--inkbook-scene-foreground-visibility")).toBe(
        "hidden",
      );
      h.read.mockClear();
      const reveal = vi.spyOn(h.renderer, "revealSurface");
      h.handoff.onSceneReveal = reveal;
      h.handoff.ready(undefined, () => h.renderer.sceneCommitProof);
      if (mode !== "reduced") {
        h.scheduler.runNext();
        expect(h.preview.hidden).toBe(false);
        h.scheduler.runNext();
      }
      expect(h.preview.hidden).toBe(true);
      expect(h.classes.contains("inkbook-active-preparing")).toBe(false);
      expect(reveal).toHaveBeenCalledOnce();
      expect(h.read).not.toHaveBeenCalled();
      expect(h.stabilize).toHaveBeenCalledTimes(mode === "initial" ? 0 : 1);
      reveal.mockRestore();
    } finally {
      h.handoff.dispose();
      h.entrance?.dispose();
      h.renderer.destroy();
    }
    expect(h.scheduler.pendingCount).toBe(0);
  },
);

it.each(["full", "reduced", "initial"] as const)(
  "releases the hidden preview only after the visual %s unlock settles",
  async (mode) => {
    const h = fixture(mode);
    const release = vi.fn();
    h.handoff.onUnlockSettled = release;
    try {
      h.handoff.ready(undefined, () => h.renderer.sceneCommitProof);
      if (mode !== "reduced") {
        h.scheduler.runNext();
        h.scheduler.runNext();
        expect(release).not.toHaveBeenCalled();
        h.scheduler.runAll();
        await Promise.resolve();
      }
      expect(release).toHaveBeenCalledOnce();
      expect(h.preview.hidden).toBe(true);
    } finally {
      h.handoff.dispose();
      h.entrance?.dispose();
      h.renderer.destroy();
    }
  },
);
