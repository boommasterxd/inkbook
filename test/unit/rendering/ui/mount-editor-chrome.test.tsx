import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountEditorChrome } from "../../../../src/rendering/ui/mount-editor-chrome";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";

const reactRoot = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => reactRoot) }));

beforeEach(() => {
  vi.mocked(createRoot).mockClear();
  reactRoot.render.mockClear();
  reactRoot.unmount.mockClear();
});

describe("editor chrome mount", () => {
  it("releases every React root across repeated mount and unmount cycles", async () => {
    const ownerDocument = {} as Document;
    const mounts = Array.from({ length: 25 }, () =>
      mountEditorChrome({ ownerDocument } as HTMLElement, createEditorChromeProps(ownerDocument)),
    );

    for (const mounted of mounts) mounted.unmount();
    await expect(Promise.all(mounts.map(({ ready }) => ready))).resolves.toEqual(
      Array.from({ length: mounts.length }, () => false),
    );
    expect(createRoot).toHaveBeenCalledTimes(mounts.length);
    expect(reactRoot.unmount).toHaveBeenCalledTimes(mounts.length);
  });

  it("renders, updates, and unmounts one owner-document React root", () => {
    const ownerDocument = {} as Document;
    const initial = createEditorChromeProps(ownerDocument);
    const mounted = mountEditorChrome({ ownerDocument } as HTMLElement, initial);

    expect(createRoot).toHaveBeenCalledOnce();
    expect(mounted.ready).toBeInstanceOf(Promise);
    expect(reactRoot.render).toHaveBeenCalledOnce();
    mounted.update({ ...initial, toolbarState: { ...initial.toolbarState } });
    expect(reactRoot.render).toHaveBeenCalledOnce();
    mounted.update({
      ...initial,
      toolbarState: { ...initial.toolbarState, activeTool: "select" },
    });
    expect(reactRoot.render).toHaveBeenCalledTimes(2);
    mounted.unmount();
    mounted.unmount();
    expect(reactRoot.unmount).toHaveBeenCalledOnce();
    expect(() => mounted.update(createEditorChromeProps(ownerDocument))).toThrow(/unmounted/u);
  });

  it("rejects a root or update from another document", () => {
    const ownerDocument = {} as Document;
    const container = { ownerDocument } as HTMLElement;
    expect(() => mountEditorChrome(container, createEditorChromeProps({} as Document))).toThrow(
      /owning document/u,
    );

    const mounted = mountEditorChrome(container, createEditorChromeProps(ownerDocument));
    expect(() => mounted.update(createEditorChromeProps({} as Document))).toThrow(
      /owning document/u,
    );
  });
});
