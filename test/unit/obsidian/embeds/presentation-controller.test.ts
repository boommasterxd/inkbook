import { describe, expect, it, vi } from "vitest";

import {
  BrowserLockedPreviewSchemeCapability,
  LOCKED_PREVIEW_SCHEME_TEST_SVG,
} from "../../../../src/obsidian/embeds/locked-preview-scheme-capability";
import { PresentationController } from "../../../../src/obsidian/embeds/presentation-controller";
import type { PresentationAttachmentInput } from "../../../../src/obsidian/embeds/presentation-port";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import { validateSafeSvg } from "../../../../src/persistence/documents/safe-svg-validator";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";

describe("locked-preview color-scheme capability", () => {
  it("uses a minimal canonical Inkbook envelope for the render comparison", () => {
    expect(validateSafeSvg(LOCKED_PREVIEW_SCHEME_TEST_SVG)).toMatchObject({
      lockedHeight: 148.6,
      paths: 1,
      revision: 0,
      version: 1,
    });
  });

  it("performs and shares one in-memory render comparison per owning Window", async () => {
    const fixture = createSchemeCapabilityWindow();
    const capability = new BrowserLockedPreviewSchemeCapability();
    const first = capability.supportsContextRepaint(fixture.window);
    const second = capability.supportsContextRepaint(fixture.window);

    expect(second.result).toBe(first.result);
    first.dispose();
    expect(fixture.revokeObjectUrl).not.toHaveBeenCalled();
    fixture.triggerLoad();
    fixture.flushFrames();
    await expect(second.result).resolves.toBe(true);
    expect(fixture.createObjectUrl).toHaveBeenCalledOnce();
    expect(fixture.revokeObjectUrl).toHaveBeenCalledOnce();
    second.dispose();
  });

  it("cancels pending paint, timer, DOM and Blob resources after the final early dispose", async () => {
    const fixture = createSchemeCapabilityWindow();
    const capability = new BrowserLockedPreviewSchemeCapability();
    const check = capability.supportsContextRepaint(fixture.window);

    fixture.triggerLoad();
    check.dispose();

    await expect(check.result).resolves.toBe(false);
    expect(fixture.clearTimeout).toHaveBeenCalledWith(11);
    expect(fixture.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(fixture.image.remove).toHaveBeenCalledOnce();
    expect(fixture.canvas.remove).toHaveBeenCalledOnce();
    expect(fixture.image.onload).toBeNull();
    expect(fixture.image.onerror).toBeNull();
    expect(fixture.revokeObjectUrl).toHaveBeenCalledWith("blob:scheme-capability");
    fixture.flushFrames();
  });
});

describe("locked-preview scheme replacement", () => {
  it("replaces a lifecycle-owned locked image only after a real scheme change needs it", async () => {
    let dark = false;
    const scheme = new ColorSchemeBroadcaster({
      getColorScheme: () => (dark ? "dark" : "light"),
    });
    const root = new FakePresentationElement();
    const button = root.createEl("button");
    const image = button.createEl("img");
    image.src = "app://vault/ink.svg";
    const replacement = vi.fn();
    const sessions = {
      activate: vi.fn(),
      detach: vi.fn(),
      mount: vi.fn(() => {
        root.dataset.inkbookState = "locked";
      }),
    };
    const controller = new PresentationController(
      createPresentationAttachment(root, "reading-1"),
      sessions,
      scheme,
      {
        capability: {
          supportsContextRepaint: () => ({ dispose: vi.fn(), result: Promise.resolve(false) }),
        },
        image: image as unknown as HTMLImageElement,
        onImageReplaced: replacement,
      },
    );
    controller.mount();

    scheme.refresh();
    await Promise.resolve();
    expect(replacement).not.toHaveBeenCalled();

    dark = true;
    scheme.refresh();
    await vi.waitFor(() => expect(replacement).toHaveBeenCalledOnce());
    const replacedImage = replacement.mock.calls[0]?.[0] as FakePresentationElement;
    expect(replacedImage.src).toBe("app://vault/ink.svg");

    scheme.refresh();
    await Promise.resolve();
    expect(replacement).toHaveBeenCalledOnce();
    controller.dispose();
  });
});

describe("locked-preview scheme lifecycle", () => {
  it("disposes a pending capability check and ignores its late result on widget unload", async () => {
    let resolveCapability = (_supported: boolean): void => undefined;
    const result = new Promise<boolean>((resolve) => {
      resolveCapability = resolve;
    });
    const disposeCapability = vi.fn();
    let dark = false;
    const scheme = new ColorSchemeBroadcaster({
      getColorScheme: () => (dark ? "dark" : "light"),
    });
    const root = new FakePresentationElement();
    const image = root.createEl("img");
    const replacement = vi.fn();
    const controller = new PresentationController(
      createPresentationAttachment(root, "reading-pending-probe"),
      { activate: vi.fn(), detach: vi.fn(), mount: vi.fn() },
      scheme,
      {
        capability: { supportsContextRepaint: () => ({ dispose: disposeCapability, result }) },
        image: image as unknown as HTMLImageElement,
        onImageReplaced: replacement,
      },
    );
    controller.mount();
    dark = true;
    scheme.refresh();

    controller.dispose();
    resolveCapability(false);
    await result;
    await Promise.resolve();

    expect(disposeCapability).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });
});

describe("presentation owner measurement", () => {
  it("clamps the presentation to the scroll-owner client edge before accepting its width", () => {
    const owner = new FakePresentationElement();
    owner.clientWidth = 400;
    const root = new FakePresentationElement(owner.ownerDocument);
    owner.append(root);
    const styles = new Map<string, string>();
    let clamped = false;
    root.style.setProperty = (name, value) => {
      styles.set(name, value);
      if (name === "--inkbook-owner-inline-limit") clamped = true;
    };
    root.getBoundingClientRect = () => ({
      bottom: 100,
      height: 100,
      left: 100,
      right: clamped ? 400 : 700,
      top: 0,
      width: clamped ? 300 : 600,
    });
    const scheme = new ColorSchemeBroadcaster({ getColorScheme: () => "light" });
    const controller = new PresentationController(
      createPresentationAttachment(root, "reading-clamped"),
      { activate: vi.fn(), detach: vi.fn(), mount: vi.fn() },
      scheme,
    );

    controller.mount();

    expect(styles.get("--inkbook-owner-inline-limit")).toBe("300px");
    expect(styles.get("--inkbook-container-width")).toBe("300px");
    expect(controller.scrollOwner).toBe(owner);
    controller.dispose();
  });
});

function createPresentationAttachment(
  root: FakePresentationElement,
  attachmentId: string,
): PresentationAttachmentInput {
  return {
    attachmentGeneration: 1,
    attachmentId,
    documentId: "drawings/ink.svg",
    embedReference: {
      documentId: "drawings/ink.svg",
      from: 4,
      kind: "live-preview",
      sourcePath: "notes/note.md",
      to: 28,
    },
    root: root as unknown as HTMLElement,
  };
}

function createSchemeCapabilityWindow(): {
  readonly cancelAnimationFrame: ReturnType<typeof vi.fn>;
  readonly canvas: { readonly remove: ReturnType<typeof vi.fn> };
  readonly clearTimeout: ReturnType<typeof vi.fn>;
  readonly createObjectUrl: ReturnType<typeof vi.fn>;
  readonly flushFrames: () => void;
  readonly image: {
    onerror: OnErrorEventHandler;
    onload: ((event: Event) => void) | null;
    readonly remove: ReturnType<typeof vi.fn>;
  };
  readonly revokeObjectUrl: ReturnType<typeof vi.fn>;
  readonly triggerLoad: () => void;
  readonly window: Window;
} {
  let renderedImage: { readonly style: { colorScheme: string } } | undefined;
  const imageStyle = { colorScheme: "", inset: "", position: "" };
  const image = {
    alt: "",
    height: 0,
    onerror: null as OnErrorEventHandler,
    onload: null as ((event: Event) => void) | null,
    remove: vi.fn(),
    setCssProps: (properties: Record<string, string>) => Object.assign(imageStyle, properties),
    style: imageStyle,
    width: 0,
    src: "",
  };
  const context = {
    clearRect: vi.fn(),
    drawImage: (nextImage: typeof image) => {
      renderedImage = nextImage;
    },
    getImageData: () => ({
      data:
        renderedImage?.style.colorScheme === "dark"
          ? new Uint8ClampedArray([40, 40, 40, 255])
          : new Uint8ClampedArray([246, 246, 246, 255]),
    }),
  };
  const canvasStyle = { inset: "", pointerEvents: "", position: "" };
  const canvas = {
    getContext: () => context,
    height: 0,
    remove: vi.fn(),
    setCssProps: (properties: Record<string, string>) => Object.assign(canvasStyle, properties),
    style: canvasStyle,
    width: 0,
  };
  const createObjectUrl = vi.fn(() => "blob:scheme-capability");
  const revokeObjectUrl = vi.fn();
  const clearTimeout = vi.fn();
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  const cancelAnimationFrame = vi.fn((frame: number) => frames.delete(frame));
  const window = {
    Blob,
    URL: { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl },
    cancelAnimationFrame,
    clearTimeout,
    document: {
      body: { createEl: (tag: string) => (tag === "canvas" ? canvas : image) },
    },
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    },
    setTimeout: vi.fn(() => 11),
  } as unknown as Window;
  return {
    cancelAnimationFrame,
    canvas,
    clearTimeout,
    createObjectUrl,
    flushFrames: () => {
      let step = frames.entries().next();
      while (!step.done) {
        const [frame, callback] = step.value;
        frames.delete(frame);
        callback(0);
        step = frames.entries().next();
      }
    },
    image,
    revokeObjectUrl,
    triggerLoad: () => image.onload?.(new Event("load")),
    window,
  };
}
