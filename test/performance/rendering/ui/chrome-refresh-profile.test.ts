import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountEditorChrome } from "../../../../src/rendering/ui/mount-editor-chrome";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

const reactRoot = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => reactRoot) }));

beforeEach(() => {
  vi.mocked(createRoot).mockClear();
  reactRoot.render.mockClear();
  reactRoot.unmount.mockClear();
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz React chrome profile`, () => {
  it("skips semantically unchanged chrome renders during continuous input", () => {
    const ownerDocument = {} as Document;
    const initial = createEditorChromeProps(ownerDocument);
    const mounted = mountEditorChrome({ ownerDocument } as HTMLElement, initial);

    for (let update = 0; update < 12; update += 1) {
      mounted.update({
        ...initial,
        shapeIcon: { ...initial.shapeIcon },
        styleIcon: { ...initial.styleIcon },
        toolbarState: { ...initial.toolbarState },
      });
    }
    expect(createRoot).toHaveBeenCalledOnce();
    expect(reactRoot.render).toHaveBeenCalledOnce();
    mounted.unmount();
    expect(reactRoot.unmount).toHaveBeenCalledOnce();
  });
});
