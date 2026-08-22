import { describe, expect, it, vi } from "vitest";

import {
  createActiveSceneChromeElements,
  updateActiveSceneChrome,
} from "../../../../src/obsidian/embeds/active-scene-chrome";

class FakeChromeElement {
  readonly children: FakeChromeElement[] = [];
  readonly classNames = new Set<string>();

  public createDiv(options?: { readonly cls?: string }): HTMLDivElement {
    const child = new FakeChromeElement();
    for (const name of options?.cls?.split(" ") ?? []) child.classNames.add(name);
    this.children.push(child);
    return child as unknown as HTMLDivElement;
  }
}

describe("active scene chrome updates", () => {
  it("uses one full-embed wrapper as the sticky toolbar boundary and transition surface", () => {
    const root = new FakeChromeElement();

    const elements = createActiveSceneChromeElements(root as unknown as HTMLElement);
    const editorChrome = elements.editorChrome as unknown as FakeChromeElement;
    const chromeHost = elements.chromeHost as unknown as FakeChromeElement;
    const container = elements.container as unknown as FakeChromeElement;

    expect(root.children).toEqual([editorChrome]);
    expect(editorChrome.classNames).toContain("inkbook-editor-chrome");
    expect(editorChrome.children).toEqual([chromeHost, container]);
    expect(chromeHost.classNames).toContain("inkbook-editor-chrome-host");
    expect(container.classNames).toContain("inkbook-background-container");
  });

  it("remeasures layout after updating React chrome state", () => {
    const props = { marker: "next" };
    const chrome = { update: vi.fn() };
    const controller = { chromeProps: vi.fn(() => props) };
    const layout = { chromeChanged: vi.fn() };

    updateActiveSceneChrome(chrome as never, controller as never, layout);

    expect(chrome.update).toHaveBeenCalledWith(props);
    expect(layout.chromeChanged).toHaveBeenCalledOnce();
  });
});
