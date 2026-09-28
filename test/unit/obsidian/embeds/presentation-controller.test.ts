import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";
import { describe, expect, it, vi } from "vitest";

import { PresentationController } from "../../../../src/obsidian/embeds/presentation-controller";
import type { PresentationAttachmentInput } from "../../../../src/obsidian/embeds/presentation-port";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";

describe("locked-preview scheme replacement", () => {
  it("hands the initial loading timestamp to the attachment only once", () => {
    const root = new FakePresentationElement();
    const preview = root.createDiv();
    const mount = vi.fn();
    const entranceState = { presented: false, loadingStartedAt: 123 };
    const controller = new PresentationController(
      createPresentationAttachment(root, "loading-handoff"),
      { activate: vi.fn(), detach: vi.fn(), mount },
      new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
      { element: preview as unknown as HTMLElement, entranceState },
      workSchedulerFromFrames(root.ownerDocument.defaultView as Window),
    );
    controller.mount();
    expect(mount).toHaveBeenCalledWith(expect.objectContaining({ loadingStartedAt: 123 }));
    expect(entranceState).not.toHaveProperty("loadingStartedAt");
    controller.dispose();
  });

  it("refreshes a plugin-owned preview surface once per real scheme transition", () => {
    let dark = false;
    const scheme = new ColorSchemeBroadcaster({
      getColorScheme: () => (dark ? "dark" : "light"),
    });
    const root = new FakePresentationElement();
    const preview = root.createDiv();
    const refresh = vi.fn();
    const controller = new PresentationController(
      createPresentationAttachment(root, "reading-owned-preview"),
      { activate: vi.fn(), detach: vi.fn(), mount: vi.fn() },
      scheme,
      { element: preview as unknown as HTMLElement, refresh },
      workSchedulerFromFrames(root.ownerDocument.defaultView as Window),
    );
    controller.mount();

    scheme.refresh();
    expect(refresh).not.toHaveBeenCalled();
    dark = true;
    scheme.refresh();
    expect(refresh).toHaveBeenCalledOnce();
    scheme.refresh();
    expect(refresh).toHaveBeenCalledOnce();

    controller.dispose();
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
      undefined,
      workSchedulerFromFrames(root.ownerDocument.defaultView as Window),
    );

    controller.mount();

    expect(styles.get("--inkbook-owner-inline-limit")).toBe("300px");
    expect(styles.get("--inkbook-container-width")).toBe("300px");
    expect(styles.get("--inkbook-shell-radius")).toBe("10px");
    expect(controller.scrollOwner).toBe(owner);
    controller.dispose();
  });

  it("remeasures host geometry when the owning window changes size", () => {
    const owner = new FakePresentationElement();
    owner.clientWidth = 800;
    const root = new FakePresentationElement(owner.ownerDocument);
    owner.append(root);
    const requestHostMeasure = vi.fn();
    const controller = mountMeasuredPresentation(root, "reading-window-resize", requestHostMeasure);

    owner.clientWidth = 1_000;
    root.ownerDocument.defaultView?.dispatchEvent(new Event("resize"));

    expect(requestHostMeasure).toHaveBeenCalledOnce();
    controller.dispose();
    root.ownerDocument.defaultView?.dispatchEvent(new Event("resize"));
    expect(requestHostMeasure).toHaveBeenCalledOnce();
  });

  it("defers repeated host measurements until a height transition ends", () => {
    const owner = new FakePresentationElement();
    const root = new FakePresentationElement(owner.ownerDocument);
    owner.append(root);
    const observers = installObservers(root.ownerDocument.defaultView as Window);
    const requestHostMeasure = vi.fn();
    const controller = mountMeasuredPresentation(
      root,
      "reading-height-transition",
      requestHostMeasure,
    );
    root.classList.add("inkbook-layout-transitioning");

    observers.resize();
    observers.resize();
    expect(requestHostMeasure).not.toHaveBeenCalled();

    root.classList.remove("inkbook-layout-transitioning");
    observers.mutate();
    expect(requestHostMeasure).toHaveBeenCalledOnce();
    controller.dispose();
  });
});

function mountMeasuredPresentation(
  root: FakePresentationElement,
  id: string,
  requestHostMeasure: () => void,
): PresentationController {
  const controller = new PresentationController(
    createPresentationAttachment(root, id),
    { activate: vi.fn(), detach: vi.fn(), mount: vi.fn() },
    new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
    { element: root as unknown as HTMLElement, requestHostMeasure },
    workSchedulerFromFrames(root.ownerDocument.defaultView as Window),
  );
  controller.mount();
  return controller;
}

function installObservers(ownerWindow: Window): {
  readonly mutate: () => void;
  readonly resize: () => void;
} {
  let mutationCallback: MutationCallback | undefined;
  let resizeCallback: ResizeObserverCallback | undefined;
  Object.assign(ownerWindow, {
    MutationObserver: class {
      public constructor(callback: MutationCallback) {
        mutationCallback = callback;
      }
      public disconnect(): void {}
      public observe(): void {}
    },
    ResizeObserver: class {
      public constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      public disconnect(): void {}
      public observe(): void {}
    },
  });
  return {
    mutate: () => mutationCallback?.([], {} as MutationObserver),
    resize: () => resizeCallback?.([], {} as ResizeObserver),
  };
}

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
