import { workSchedulerFromFrames } from "../../../../../fixtures/obsidian/work-scheduler";
import { describe, expect, it, vi } from "vitest";

import type { InitialPresentationEntrance } from "../../../../../../src/obsidian/embeds/presentation/presentation-entrance";
import { ActiveScenePreviewHandoff } from "../../../../../../src/obsidian/embeds/active-scene/active-scene";
import { FakeClassList } from "../../../../../fixtures/obsidian/class-list";

class FakeMediaQueryList {
  readonly addEventListener = vi.fn((_type: string, listener: () => void) => {
    this.#listener = listener;
  });
  matches: boolean;
  readonly removeEventListener = vi.fn((_type: string, listener: () => void) => {
    if (this.#listener === listener) this.#listener = undefined;
  });
  #listener: (() => void) | undefined;

  constructor(matches: boolean) {
    this.matches = matches;
  }

  setMatches(matches: boolean): void {
    this.matches = matches;
    this.#listener?.();
  }
}

interface HandoffFixture {
  readonly beginScrollStability: ReturnType<typeof vi.fn>;
  readonly container: HTMLElement;
  readonly measureContainer: ReturnType<typeof vi.fn>;
  readonly handoff: ActiveScenePreviewHandoff;
  readonly media: FakeMediaQueryList;
  readonly preview: HTMLImageElement;
  readonly rootClasses: FakeClassList;
  readonly runFrame: () => void;
  readonly framePending: () => boolean;
  readonly setActiveBlockSize: (value: string) => void;
  readonly setTimeoutSpy: ReturnType<typeof vi.fn>;
  readonly completed: () => void;
  readonly releaseScrollStability: ReturnType<typeof vi.fn>;
}

function createFixture(
  motion: "full" | "reduced" | "system",
  systemReduced = false,
  setPreviewAspectRatio?: (aspectRatio: number) => void,
  initialScrollStability = false,
  initialEntrance?: InitialPresentationEntrance,
): HandoffFixture {
  const media = new FakeMediaQueryList(systemReduced);
  let frame: FrameRequestCallback | undefined;
  let frameTime = 0;
  const setTimeoutSpy = vi.fn(() => 1);
  const ownerWindow = {
    matchMedia: () => media,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      frame = callback;
      return 2;
    },
    cancelAnimationFrame: vi.fn(() => {
      frame = undefined;
    }),
    setTimeout: setTimeoutSpy,
  } as unknown as Window;
  const rootClasses = new FakeClassList();
  const ownerDocument = { defaultView: ownerWindow };
  const root = {
    classList: rootClasses,
    ownerDocument,
  } as unknown as HTMLElement;
  const style = {
    blockSize: "",
    properties: new Map<string, string>(),
    getPropertyValue: (name: string): string => style.properties.get(name) ?? "",
    removeProperty: (name: string): string => {
      const previous = style.properties.get(name) ?? "";
      style.properties.delete(name);
      return previous;
    },
    setProperty: (name: string, value: string): void => {
      if (name === "block-size") style.blockSize = value;
      else style.properties.set(name, value);
    },
  };
  const measureContainer = vi.fn(() => ({ height: 240 }));
  const container = {
    classList: new FakeClassList(),
    ownerDocument,
    getBoundingClientRect: measureContainer,
    style,
  } as unknown as HTMLElement;
  const previewClasses = new FakeClassList();
  const previewStyle = {
    inset: "",
    position: "",
    zIndex: "",
    removeProperty: vi.fn(),
  };
  const preview = {
    classList: previewClasses,
    ownerDocument,
    getBoundingClientRect: () => ({ height: 96 }),
    hidden: false,
    remove: vi.fn(),
    setCssProps: (properties: Record<string, string>) => Object.assign(previewStyle, properties),
    style: previewStyle,
  } as unknown as HTMLImageElement;
  const completed = vi.fn<() => void>();
  const releaseScrollStability = vi.fn();
  const beginScrollStability = vi.fn(() => releaseScrollStability);
  return {
    beginScrollStability,
    completed,
    container,
    measureContainer,
    handoff: new ActiveScenePreviewHandoff({
      workScheduler: workSchedulerFromFrames(ownerWindow, { now: () => frameTime }),
      ...(initialEntrance === undefined ? {} : { initialEntrance }),
      beginScrollStability,
      container,
      ...(initialScrollStability ? { initialScrollStabilityRelease: releaseScrollStability } : {}),
      motion,
      preview,
      root,
      ...(setPreviewAspectRatio === undefined ? {} : { setPreviewAspectRatio }),
    }),
    media,
    preview,
    releaseScrollStability,
    rootClasses,
    framePending: () => frame !== undefined,
    runFrame: () => {
      const current = frame;
      frame = undefined;
      current?.((frameTime += 16));
    },
    setActiveBlockSize: (value) => {
      style.blockSize = value;
    },
    setTimeoutSpy,
  };
}

describe("active editor initial visibility proof", () => {
  it.each(["full", "reduced", "system"] as const)(
    "waits for one paint of an unchanged complete scene proof with %s motion",
    (motion) => {
      const h = createFixture(motion);
      h.setActiveBlockSize("240px");
      let proof: number | undefined;
      h.handoff.ready(h.completed, () => proof);
      h.runFrame();
      proof = 1;
      h.runFrame();
      expect(h.preview.hidden).toBe(false);
      expect(h.completed).not.toHaveBeenCalled();
      h.runFrame();
      proof = 2;
      h.setActiveBlockSize("360px");
      h.runFrame();
      expect(h.completed).not.toHaveBeenCalled();
      if (motion === "system") h.media.setMatches(true);
      else {
        h.runFrame();
        h.runFrame();
        for (let frame = 0; frame < 16; frame += 1) h.runFrame();
      }
      expect(h.completed).toHaveBeenCalledOnce();
      expect(h.preview.hidden).toBe(true);
      expect(h.container.style.blockSize).toBe("360px");
      h.handoff.dispose();
    },
  );

  it("does not reveal a pending scene when reduced motion changes or disposal occurs", () => {
    const h = createFixture("system");
    h.handoff.ready(h.completed, () => undefined);
    h.media.setMatches(true);
    h.runFrame();
    h.runFrame();
    expect(h.preview.hidden).toBe(false);
    expect(h.completed).not.toHaveBeenCalled();
    h.handoff.dispose();
    expect(h.framePending()).toBe(false);
    expect(h.completed).not.toHaveBeenCalled();
  });
});

describe("active editor unlock preview motion", () => {
  it("keeps the preview in the same block until the in-place editor is ready", () => {
    const fixture = createFixture("full", true);
    expect(fixture.rootClasses.contains("inkbook-active-preparing")).toBe(true);
    expect(fixture.container.style.blockSize).toBe("96px");
    expect(fixture.container.style.getPropertyValue("--inkbook-locked-container-block-size")).toBe(
      "96px",
    );
    expect(fixture.preview.hidden).toBe(false);

    fixture.setActiveBlockSize("240px");
    fixture.handoff.ready(fixture.completed);
    expect(fixture.rootClasses.contains("inkbook-active-preparing")).toBe(true);
    expect(fixture.container.style.blockSize).toBe("240px");
    expect(fixture.container.style.getPropertyValue("--inkbook-active-scene-block-size")).toBe(
      "240px",
    );
    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.completed).not.toHaveBeenCalled();
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();

    fixture.runFrame();
    expect(fixture.rootClasses.contains("inkbook-active-preparing")).toBe(true);
    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();

    fixture.runFrame();
    expect(fixture.rootClasses.contains("inkbook-active-transitioning")).toBe(true);
    expect(fixture.beginScrollStability).toHaveBeenCalledOnce();
    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.completed).toHaveBeenCalledOnce();

    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();
    for (let frame = 0; frame < 7; frame += 1) fixture.runFrame();
    // The former CSS unlock used ease-out; its early growth must stay distinct
    // from the smoothstep used by automatic page-height changes.
    expect(Number.parseFloat(fixture.container.style.blockSize)).toBeGreaterThan(180);
    for (let frame = 7; frame < 16; frame += 1) fixture.runFrame();
    expect(fixture.rootClasses.contains("inkbook-active-ready")).toBe(true);
    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.completed).toHaveBeenCalledOnce();
    expect(fixture.container.style.getPropertyValue("--inkbook-active-scene-block-size")).toBe("");
    expect(fixture.container.style.getPropertyValue("--inkbook-locked-container-block-size")).toBe(
      "",
    );
    expect(fixture.releaseScrollStability).toHaveBeenCalledOnce();
    expect(fixture.measureContainer).not.toHaveBeenCalled();
  });

  it.each(["reduced", "system"] as const)("applies initial %s reduction immediately", (motion) => {
    const fixture = createFixture(motion, true);
    fixture.setActiveBlockSize("240px");
    fixture.handoff.ready();
    expect(fixture.rootClasses.contains("inkbook-active-transitioning")).toBe(false);
    expect(fixture.rootClasses.contains("inkbook-active-ready")).toBe(true);
    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();
    expect(fixture.measureContainer).not.toHaveBeenCalled();
  });
});

describe("active editor live motion preference", () => {
  it.each(["device", "system"])("settles an unlocking height on %s reduction", (source) => {
    const fixture = createFixture(source === "system" ? "system" : "full");
    fixture.setActiveBlockSize("640px");
    fixture.handoff.ready(fixture.completed);
    for (let frame = 0; frame < 6; frame += 1) fixture.runFrame();
    const intermediate = Number.parseFloat(fixture.container.style.blockSize);
    expect(intermediate).toBeGreaterThan(96);
    expect(intermediate).toBeLessThan(640);
    if (source === "system") fixture.media.setMatches(true);
    else fixture.handoff.updateMotion("reduced");
    expect(fixture.container.style.blockSize).toBe("640px");
    expect(fixture.rootClasses.contains("inkbook-active-ready")).toBe(true);
    expect(fixture.releaseScrollStability).toHaveBeenCalledOnce();
    expect(fixture.framePending()).toBe(false);
    expect(fixture.completed).toHaveBeenCalledOnce();
    fixture.handoff.dispose();
  });

  it("follows system motion changes and releases lifecycle resources", () => {
    const fixture = createFixture("system");
    const preference = vi.fn();
    fixture.handoff.onReducedMotionChange = preference;
    expect(fixture.handoff.reducedMotion).toBe(false);
    fixture.setActiveBlockSize("240px");
    fixture.handoff.ready();
    expect(fixture.framePending()).toBe(true);

    fixture.media.setMatches(true);
    expect(preference).toHaveBeenLastCalledWith(true);
    fixture.media.setMatches(false);
    expect(preference).toHaveBeenLastCalledWith(false);
    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();

    fixture.handoff.dispose();
    fixture.media.setMatches(true);
    expect(preference).toHaveBeenCalledTimes(2);
    expect(fixture.media.removeEventListener).toHaveBeenCalledOnce();
    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.rootClasses.contains("inkbook-active-ready")).toBe(false);
    expect(fixture.container.style.getPropertyValue("--inkbook-active-scene-block-size")).toBe("");
    expect(fixture.container.style.getPropertyValue("--inkbook-locked-container-block-size")).toBe(
      "",
    );
  });

  it("cancels a pending handoff when the scene is disposed", () => {
    const fixture = createFixture("system");
    fixture.setActiveBlockSize("240px");
    fixture.handoff.ready();
    expect(fixture.framePending()).toBe(true);

    fixture.handoff.dispose();
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();
    expect(fixture.framePending()).toBe(false);
    expect(fixture.media.removeEventListener).toHaveBeenCalledOnce();
    expect(fixture.preview.hidden).toBe(false);
    for (let frame = 0; frame < 16; frame += 1) fixture.runFrame();
    expect(fixture.rootClasses.contains("inkbook-active-ready")).toBe(false);
  });
});

describe("active editor pre-mount scroll stability", () => {
  it("retains a lease acquired before editor DOM preparation", () => {
    const fixture = createFixture("full", false, undefined, true);
    fixture.setActiveBlockSize("240px");

    fixture.handoff.ready();
    fixture.runFrame();
    fixture.runFrame();

    expect(fixture.beginScrollStability).not.toHaveBeenCalled();
    expect(fixture.releaseScrollStability).not.toHaveBeenCalled();
    for (let frame = 0; frame < 16; frame += 1) fixture.runFrame();
    expect(fixture.releaseScrollStability).toHaveBeenCalledOnce();
  });
});

describe("active editor lock preview motion", () => {
  it("updates the held preview ratio before the lock handoff", () => {
    const setPreviewAspectRatio = vi.fn();
    const fixture = createFixture("full", false, setPreviewAspectRatio);

    fixture.handoff.setPreviewAspectRatio(4);

    expect(setPreviewAspectRatio).toHaveBeenCalledWith(4);
  });

  it("prepares the exact preview behind the editor before the atomic replacement", () => {
    const fixture = createFixture("full");
    const editorChrome = createEditorChrome();

    fixture.handoff.handoffToPreview(editorChrome, fixture.completed);

    expect(fixture.preview.style.position).toBe("absolute");
    expect(fixture.preview.style.zIndex).toBe("1");
    expect(editorChrome.style.zIndex).toBe("2");
    expect(editorChrome.hidden).toBe(false);
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();
    expect(fixture.completed).not.toHaveBeenCalled();
    fixture.runFrame();
    expect(fixture.completed).not.toHaveBeenCalled();
    fixture.runFrame();
    expect(editorChrome.hidden).toBe(true);
    expect(fixture.completed).toHaveBeenCalledOnce();
  });

  it("keeps one complete presentation visible across the lock replacement frame", () => {
    const fixture = createFixture("full");
    fixture.preview.hidden = true;
    const editor = createEditorChrome();

    fixture.handoff.handoffToPreview(editor, fixture.completed);

    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.preview.style.zIndex).toBe("1");
    expect(editor.style.zIndex).toBe("2");
    expect(editor.hidden).toBe(false);
    fixture.runFrame();
    expect(editor.hidden).toBe(false);
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();
    fixture.runFrame();
    expect(editor.hidden).toBe(true);
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();
    expect(fixture.completed).toHaveBeenCalledOnce();
  });

  it("finishes the pending lock handoff when reduced motion becomes active", () => {
    const fixture = createFixture("full");
    const editorChrome = createEditorChrome();
    fixture.handoff.handoffToPreview(editorChrome, fixture.completed);
    fixture.runFrame();
    fixture.handoff.updateMotion("reduced");

    expect(editorChrome.hidden).toBe(true);
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();
    expect(fixture.completed).toHaveBeenCalledOnce();
  });

  it("finalizes reduced-motion layout and exact preview in one synchronous handoff", () => {
    const fixture = createFixture("reduced");
    const order: string[] = [];
    fixture.preview.hidden = true;
    const editor = createEditorChrome();

    fixture.handoff.handoffToPreview(
      editor,
      () => order.push("complete"),
      () => {
        expect(fixture.preview.hidden).toBe(true);
        order.push("layout");
      },
    );

    expect(fixture.preview.hidden).toBe(false);
    expect(editor.hidden).toBe(true);
    expect(order).toEqual(["layout", "complete"]);
    expect(fixture.setTimeoutSpy).not.toHaveBeenCalled();
  });
});

function createEditorChrome(): HTMLElement {
  const style = {
    zIndex: "",
    removeProperty: vi.fn(),
  };
  const editor = {
    hidden: false,
    setCssProps: (properties: Record<string, string>) => Object.assign(style, properties),
    style,
  } as unknown as HTMLElement;
  return editor;
}

it.each([true, false])(
  "preserves normal unlock when initial reveal is available=%s",
  (available) => {
    const initialEntrance = {
      ready: Promise.resolve(true),
      activationReady: Promise.resolve(true),
      holdForActivation: vi.fn(),
      showLoading: vi.fn(),
      resumePreview: vi.fn(),
      revealActive: vi.fn(() => available),
    };
    const h = createFixture("full", false, undefined, false, initialEntrance);
    h.setActiveBlockSize("640px");
    const ready = vi.fn();
    h.handoff.ready(ready);
    h.runFrame();
    h.runFrame();
    expect(initialEntrance.revealActive).toHaveBeenCalledWith(640);
    expect(ready).toHaveBeenCalledOnce();
    expect(h.rootClasses.contains("inkbook-active-preparing")).toBe(false);
    expect(h.rootClasses.contains("inkbook-active-transitioning")).toBe(!available);
    expect(h.framePending()).toBe(!available);
    h.handoff.dispose();
  },
);

it.each(["complete", "cancel", "reject", "dispose"] as const)(
  "retains initial reveal scroll stability until %s without delaying toolbar readiness",
  async (outcome) => {
    let finish!: (presented: boolean) => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<boolean>((resolve, rejectPromise) => {
      finish = resolve;
      reject = rejectPromise;
    });
    const initialEntrance = {
      ready,
      activationReady: Promise.resolve(true),
      holdForActivation: vi.fn(),
      showLoading: vi.fn(),
      resumePreview: vi.fn(),
      revealActive: vi.fn(() => true),
    };
    const h = createFixture("full", false, undefined, true, initialEntrance);
    h.setActiveBlockSize("640px");
    h.handoff.ready(h.completed);
    h.runFrame();
    h.runFrame();
    expect(h.completed).toHaveBeenCalledOnce();
    expect(h.rootClasses.contains("inkbook-active-ready")).toBe(true);
    expect(h.preview.hidden).toBe(true);
    expect(h.setTimeoutSpy).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(h.releaseScrollStability).not.toHaveBeenCalled();
    if (outcome === "dispose") {
      h.handoff.dispose();
      expect(h.releaseScrollStability).toHaveBeenCalledOnce();
    }
    if (outcome === "reject") reject(new Error("Entrance failed"));
    else finish(outcome === "complete");
    await Promise.resolve();
    expect(h.releaseScrollStability).toHaveBeenCalledOnce();
    expect(h.completed).toHaveBeenCalledOnce();
    h.handoff.dispose();
    expect(h.releaseScrollStability).toHaveBeenCalledOnce();
  },
);
