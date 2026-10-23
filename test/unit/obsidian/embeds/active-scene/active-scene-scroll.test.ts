import { describe, expect, it, vi } from "vitest";

import {
  applyActiveSceneZoomLayout,
  bindSceneScrollOwner,
} from "../../../../../src/obsidian/embeds/active-scene/active-scene-runtime";
import type { ActiveEditorLayout } from "../../../../../src/obsidian/embeds/active-editor/layout/layout";
import type { NavigationLayoutRead } from "../../../../../src/obsidian/embeds/active-editor/navigation/navigation-layout";
import type { ActiveInkbookSceneOptions } from "../../../../../src/obsidian/embeds/active-scene/active-scene-types";
import type { ActiveEditorController } from "../../../../../src/obsidian/embeds/active-editor/controller";
import type { SvgSceneRenderer } from "../../../../../src/rendering/scene/index";
import type { BrowserScrollElement } from "../../../../../src/obsidian/scrolling/index";

it("hands only an anchored zoom height update to host measurement reconciliation", () => {
  const owner = {} as BrowserScrollElement;
  const container = {} as HTMLElement;
  const applyZoom = vi.fn(() => 2188);
  const layout = { applyZoom } as unknown as ActiveEditorLayout;
  const host = { cancel: vi.fn(), dispose: vi.fn(), retain: vi.fn() };
  const update = {
    blockSize: 2188,
    layout: {
      containerBorderTop: 100,
      containerBounds: { top: 115 },
      scrollOwner: owner,
      scrollTop: 200,
    } as NavigationLayoutRead,
    scrollTop: 812,
    zoom: 1.327,
  };
  expect(applyActiveSceneZoomLayout(layout, update, host, container)).toBe(2188);
  expect(host.retain).toHaveBeenCalledExactlyOnceWith(owner, 812, { container, contentTop: 300 });
  expect(host.cancel).not.toHaveBeenCalled();
  expect(applyActiveSceneZoomLayout(layout, { blockSize: 659, zoom: 0.4 }, host, container)).toBe(
    2188,
  );
  expect(host.cancel).toHaveBeenCalledOnce();
  expect(applyActiveSceneZoomLayout(layout, update, undefined, container)).toBe(2188);
  expect(applyZoom).toHaveBeenCalledTimes(3);
});

describe("active scene scroll ownership", () => {
  it("transfers navigation and scroll invalidation to the live owner", () => {
    const first = new EventTarget() as BrowserScrollElement;
    const second = new EventTarget() as BrowserScrollElement;
    const ownerWindow = Object.assign(new EventTarget(), {
      getComputedStyle: (owner: BrowserScrollElement) => ({
        paddingTop: owner === first ? "32px" : "16px",
      }),
    }) as unknown as Window;
    const properties = new Map<string, string>();
    const root = {
      style: { setProperty: (name: string, value: string) => properties.set(name, value) },
    } as unknown as HTMLElement;
    let liveOwner = first;
    const invalidate = vi.fn();
    const onScroll = vi.fn();
    const transfer = vi.fn();
    const cancelHostZoom = vi.fn();
    const binding = bindSceneScrollOwner(
      first,
      ownerWindow,
      {
        hostZoomScroll: { cancel: cancelHostZoom },
        root,
        scrollOwner: () => liveOwner,
      } as unknown as ActiveInkbookSceneOptions,
      { invalidateLayout: invalidate } as unknown as SvgSceneRenderer,
      {
        handleNativeScroll: onScroll,
        transferScrollOwner: transfer,
      } as unknown as ActiveEditorController,
    );

    expect(properties.get("--inkbook-toolbar-scrollport-padding")).toBe("32px");

    first.dispatchEvent(new Event("scroll"));
    expect(invalidate).toHaveBeenCalledOnce();
    expect(onScroll).toHaveBeenCalledOnce();
    ownerWindow.dispatchEvent(new Event("resize"));
    expect(onScroll).toHaveBeenCalledOnce();
    liveOwner = second;
    expect(binding.current()).toBe(second);
    expect(cancelHostZoom).toHaveBeenCalledOnce();
    expect(transfer).toHaveBeenCalledWith(second);
    expect(properties.get("--inkbook-toolbar-scrollport-padding")).toBe("16px");
    first.dispatchEvent(new Event("scroll"));
    second.dispatchEvent(new Event("scroll"));
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(onScroll).toHaveBeenCalledTimes(2);

    binding.dispose();
    second.dispatchEvent(new Event("scroll"));
    expect(invalidate).toHaveBeenCalledTimes(4);
    expect(onScroll).toHaveBeenCalledTimes(2);
  });
});
