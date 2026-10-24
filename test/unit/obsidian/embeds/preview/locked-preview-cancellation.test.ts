// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedFrameScheduler } from "../../../../../src/domain/scheduling/shared-frame-scheduler";
import { createInkbookLockedPreview } from "../../../../../src/obsidian/embeds/preview/locked-preview";
import { lockedPreviewRoot } from "../../../../fixtures/obsidian/locked-preview";
import { createHtmlElement, installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { ManualHost } from "../../../../fixtures/scheduling/manual-frame-host";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { StaticPreviewSurface } from "../../../../../src/rendering/scene/static-preview-surface";

beforeEach(() => {
  installObsidianDomHelpers();
});

it.each(["lock reversal", "disposal"])(
  "settles a pending native frame mount on %s",
  async (action) => {
    const button = document.body.appendChild(createHtmlElement("button"));
    const preview = createInkbookLockedPreview(
      button,
      {
        aspectRatio: 1,
        contentIdentity: { revision: 1, outputHash: "a".repeat(64) },
        safeSvg: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M1 0"/></svg>',
      },
      immediateWorkScheduler(),
    );
    await preview.ensureReady();
    button.hidden = true;
    const frame = button.firstElementChild!.shadowRoot!.querySelector("iframe")!;
    // Native frame contexts can be unavailable while a pop-out document is loading.
    Object.defineProperty(frame, "contentDocument", { configurable: true, value: null });
    const mounting = vi.spyOn(StaticPreviewSurface.prototype, "ensureMounted");
    let settled = false;
    const ready = preview
      .ensureReady()
      .then(
        () => "ready",
        () => "failed",
      )
      .finally(() => {
        settled = true;
      });
    try {
      await vi.waitFor(() => expect(mounting).toHaveBeenCalledOnce());
      if (action === "lock reversal") preview.releaseHiddenSurface();
      else preview.dispose();
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
      expect(await ready).toBe("ready");
      expect(button.firstElementChild!.shadowRoot!.querySelector("iframe")).toBeNull();
    } finally {
      preview.dispose();
      await ready;
    }
  },
);

it("cancels a paused lock rebuild on reversal and reconstructs only the next demanded descriptor", async () => {
  const button = document.body.appendChild(createHtmlElement("button"));
  const descriptor = (revision: number) => ({
    aspectRatio: 1,
    contentIdentity: { revision, outputHash: "a".repeat(64) },
    safeSvg: `<svg xmlns="http://www.w3.org/2000/svg"><path d="M${revision} 0"/></svg>`,
  });
  const preview = createInkbookLockedPreview(button, descriptor(1), immediateWorkScheduler());
  await preview.ensureReady();
  button.hidden = true;
  preview.releaseHiddenSurface();
  const wait = vi.fn(() => new Promise<void>(() => {}));
  preview.setBackgroundWait(wait);
  const cancelled = preview.ensureReady();
  await vi.waitFor(() => expect(wait).toHaveBeenCalled());
  preview.releaseHiddenSurface();
  await cancelled;
  expect(button.firstElementChild?.shadowRoot?.querySelector("iframe")).toBeNull();
  preview.setDescriptor(descriptor(2));
  preview.refresh();
  expect(button.firstElementChild?.shadowRoot?.querySelector("iframe")).toBeNull();
  preview.setBackgroundWait(undefined);
  await preview.ensureReady();
  expect(lockedPreviewRoot(button).querySelector("path")?.getAttribute("d")).toBe("M2 0");
  expect(button.firstElementChild?.shadowRoot?.querySelectorAll("iframe")).toHaveLength(1);
  preview.releaseHiddenSurface();
  preview.dispose();
  preview.refresh();
  await preview.ensureReady();
  expect(button.firstElementChild?.shadowRoot?.querySelector("iframe")).toBeNull();
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it("replaces a queued obsolete preparation before another frame and coalesces the latest descriptor", async () => {
  const host = new ManualHost();
  const scheduler = new SharedFrameScheduler(host);
  const checkpoint = vi.spyOn(scheduler, "checkpoint");
  const cancelFrame = vi.spyOn(host, "cancelFrame");
  host.time = scheduler.deadline();
  const descriptor = (revision: number) => ({
    aspectRatio: 1,
    contentIdentity: { outputHash: "a".repeat(64), revision },
    safeSvg: `<svg xmlns="http://www.w3.org/2000/svg"><path d="M${String(revision)} 0"/></svg>`,
  });
  const preview = createInkbookLockedPreview(
    document.body.appendChild(createHtmlElement("button")),
    descriptor(1),
    scheduler,
  );
  await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledOnce());
  expect(host.pendingFrames).toBe(1);
  preview.setDescriptor(descriptor(2));
  preview.setDescriptor(descriptor(3));
  expect(host.pendingFrames).toBe(0);
  await vi.waitFor(() => expect(checkpoint).toHaveBeenCalledTimes(2));
  expect(host.frameRequests).toBe(2);
  expect(cancelFrame).toHaveBeenCalledOnce();
  expect(lockedPreviewRoot(preview.element).querySelector("svg")).toBeNull();
  host.time = host.frameInterval;
  host.frame();
  await preview.ensureReady();
  expect(lockedPreviewRoot(preview.element).querySelector("path")?.getAttribute("d")).toBe("M3 0");
  expect(lockedPreviewRoot(preview.element).querySelectorAll("svg")).toHaveLength(1);
  preview.dispose();
  scheduler.dispose();
  expect(host.pendingFrames).toBe(0);
  expect(host.pendingTimers).toBe(0);
});
