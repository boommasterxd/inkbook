import { describe, expect, it, vi } from "vitest";

import { ActiveScenePreviewHandoff } from "../../../../src/obsidian/embeds/active-scene";

class FakeClassList {
  readonly #values = new Set<string>();

  add(...values: string[]): void {
    for (const value of values) this.#values.add(value);
  }

  contains(value: string): boolean {
    return this.#values.has(value);
  }

  remove(...values: string[]): void {
    for (const value of values) this.#values.delete(value);
  }
}

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
  readonly container: HTMLElement;
  readonly handoff: ActiveScenePreviewHandoff;
  readonly media: FakeMediaQueryList;
  readonly preview: HTMLImageElement;
  readonly rootClasses: FakeClassList;
  readonly runTimer: () => void;
  readonly runFrame: () => void;
  readonly setActiveBlockSize: (value: string) => void;
  readonly setTimeoutSpy: ReturnType<typeof vi.fn>;
  readonly timerPending: () => boolean;
  readonly completed: () => void;
}

function createFixture(
  motion: "full" | "reduced" | "system",
  systemReduced = false,
): HandoffFixture {
  const media = new FakeMediaQueryList(systemReduced);
  let timer: (() => void) | undefined;
  let frame: (() => void) | undefined;
  const setTimeoutSpy = vi.fn((callback: () => void, _delay: number) => {
    timer = callback;
    return 1;
  });
  const ownerWindow = {
    clearTimeout: vi.fn(() => {
      timer = undefined;
    }),
    matchMedia: () => media,
    requestAnimationFrame: (callback: () => void) => {
      frame = callback;
      return 2;
    },
    cancelAnimationFrame: vi.fn(() => {
      frame = undefined;
    }),
    setTimeout: setTimeoutSpy,
  } as unknown as Window;
  const rootClasses = new FakeClassList();
  const root = {
    classList: rootClasses,
    ownerDocument: { defaultView: ownerWindow },
  } as unknown as HTMLElement;
  const style = {
    blockSize: "",
    setProperty: (name: string, value: string): void => {
      if (name === "block-size") style.blockSize = value;
    },
  };
  const container = {
    getBoundingClientRect: vi.fn(() => ({ height: 240 })),
    style,
  } as unknown as HTMLElement;
  const previewClasses = new FakeClassList();
  const previewStyle = {
    inset: "",
    opacity: "",
    position: "",
    transition: "",
    removeProperty: vi.fn(),
  };
  const preview = {
    classList: previewClasses,
    getBoundingClientRect: () => ({ height: 96 }),
    hidden: false,
    remove: vi.fn(),
    setCssProps: (properties: Record<string, string>) => Object.assign(previewStyle, properties),
    style: previewStyle,
  } as unknown as HTMLImageElement;
  const completed = vi.fn<() => void>();
  return {
    completed,
    container,
    handoff: new ActiveScenePreviewHandoff({ container, motion, preview, root }),
    media,
    preview,
    rootClasses,
    runTimer: () => timer?.(),
    runFrame: () => frame?.(),
    setActiveBlockSize: (value) => {
      style.blockSize = value;
    },
    setTimeoutSpy,
    timerPending: () => timer !== undefined,
  };
}

describe("active editor unlock preview motion", () => {
  it("keeps the preview in the same block until the in-place editor is ready", () => {
    const fixture = createFixture("full", true);
    expect(fixture.rootClasses.contains("inkbook-active-preparing")).toBe(true);
    expect(fixture.container.style.blockSize).toBe("96px");
    expect(fixture.preview.hidden).toBe(false);

    fixture.setActiveBlockSize("96px");
    fixture.handoff.ready(fixture.completed);
    expect(fixture.rootClasses.contains("inkbook-active-transitioning")).toBe(true);
    expect(fixture.container.style.blockSize).toBe("96px");
    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.completed).not.toHaveBeenCalled();

    expect(fixture.setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 240);
    fixture.runTimer();
    expect(fixture.rootClasses.contains("inkbook-active-ready")).toBe(true);
    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.completed).toHaveBeenCalledOnce();
  });

  it("applies reduced motion immediately after the stable measurement", () => {
    const fixture = createFixture("reduced");
    fixture.setActiveBlockSize("96px");
    fixture.handoff.ready();
    expect(fixture.rootClasses.contains("inkbook-active-transitioning")).toBe(false);
    expect(fixture.rootClasses.contains("inkbook-active-ready")).toBe(true);
    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.timerPending()).toBe(false);
  });

  it("follows system motion changes and releases lifecycle resources", () => {
    const fixture = createFixture("system");
    fixture.setActiveBlockSize("96px");
    fixture.handoff.ready();
    expect(fixture.timerPending()).toBe(true);

    fixture.media.setMatches(true);
    expect(fixture.preview.hidden).toBe(true);
    expect(fixture.timerPending()).toBe(false);

    fixture.handoff.dispose();
    expect(fixture.media.removeEventListener).toHaveBeenCalledOnce();
    expect(fixture.preview.hidden).toBe(false);
    expect(fixture.rootClasses.contains("inkbook-active-ready")).toBe(false);
  });

  it("cancels a pending handoff when the scene is disposed", () => {
    const fixture = createFixture("system");
    fixture.setActiveBlockSize("96px");
    fixture.handoff.ready();
    expect(fixture.timerPending()).toBe(true);

    fixture.handoff.dispose();
    expect(fixture.timerPending()).toBe(false);
    expect(fixture.media.removeEventListener).toHaveBeenCalledOnce();
    expect(fixture.preview.hidden).toBe(false);
    fixture.runTimer();
    expect(fixture.rootClasses.contains("inkbook-active-ready")).toBe(false);
  });
});

describe("active editor lock preview motion", () => {
  it("crossfades the complete editor chrome including its toolbar for 120 ms", () => {
    const fixture = createFixture("full");
    const editorChrome = startFullMotionCrossfade(fixture);

    expect(fixture.preview.style.opacity).toBe("1");
    expect(editorChrome.style.opacity).toBe("0");
    expect(fixture.setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 120);
    expect(fixture.completed).not.toHaveBeenCalled();
    fixture.runTimer();
    expect(fixture.completed).toHaveBeenCalledOnce();
  });

  it("finishes the complete lock crossfade when reduced motion becomes active", () => {
    const fixture = createFixture("full");
    const editorChrome = startFullMotionCrossfade(fixture);
    fixture.handoff.updateMotion("reduced");

    expect(fixture.preview.style.opacity).toBe("1");
    expect(fixture.preview.style.transition).toBe("none");
    expect(editorChrome.style.opacity).toBe("0");
    expect(editorChrome.style.transition).toBe("none");
    expect(fixture.timerPending()).toBe(false);
    expect(fixture.completed).toHaveBeenCalledOnce();
  });

  it("finalizes reduced-motion layout and exact preview in one synchronous handoff", () => {
    const fixture = createFixture("reduced");
    const order: string[] = [];
    fixture.preview.hidden = true;
    const setEditorCss = vi.fn();
    const editor = { setCssProps: setEditorCss } as unknown as HTMLElement;

    fixture.handoff.crossfadeToPreview(
      editor,
      () => order.push("complete"),
      () => {
        expect(fixture.preview.hidden).toBe(true);
        order.push("layout");
      },
    );

    expect(fixture.preview.hidden).toBe(false);
    expect(setEditorCss).toHaveBeenCalledWith({ opacity: "0", transition: "none" });
    expect(order).toEqual(["layout", "complete"]);
    expect(fixture.timerPending()).toBe(false);
  });
});

function startFullMotionCrossfade(fixture: HandoffFixture): HTMLElement {
  const style = { opacity: "", transition: "" };
  const editor = {
    setCssProps: (properties: Record<string, string>) => Object.assign(style, properties),
    style,
  } as unknown as HTMLElement;
  fixture.handoff.crossfadeToPreview(editor, fixture.completed);
  fixture.runFrame();
  return editor;
}
