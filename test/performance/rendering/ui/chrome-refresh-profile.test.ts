import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountEditorChrome } from "../../../../src/rendering/ui/mount-editor-chrome";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";
import {
  INTERACTION_REFRESH_PROFILE,
  interactionP99,
  interactionProfileAnnotation,
  measureInteractionFrames,
} from "../../interaction-refresh-profile";
import { timingBudget } from "../../timing-budget";

const reactRoot = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => reactRoot) }));

beforeEach(() => {
  vi.mocked(createRoot).mockClear();
  reactRoot.render.mockClear();
  reactRoot.unmount.mockClear();
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz React chrome profile`, () => {
  it("skips semantically unchanged chrome renders during continuous input", async ({
    annotate,
  }) => {
    const ownerDocument = {} as Document;
    const initial = createEditorChromeProps(ownerDocument);
    const mounted = mountEditorChrome({ ownerDocument } as HTMLElement, initial);

    const durations = measureInteractionFrames(() => {
      mounted.update({
        ...initial,
        background: { ...initial.background },
        overflowMenu: {
          ...initial.overflowMenu,
          arrange: { ...initial.overflowMenu.arrange },
        },
        styleControls: [...initial.styleControls],
        styleIcon: { ...initial.styleIcon },
        toolbarState: { ...initial.toolbarState },
      });
    });

    const p99 = interactionP99(durations);
    expect(createRoot).toHaveBeenCalledOnce();
    expect(reactRoot.render).toHaveBeenCalledOnce();
    expect(p99).toBeLessThanOrEqual(timingBudget(INTERACTION_REFRESH_PROFILE.mainThreadP99Ms));
    await annotate(interactionProfileAnnotation("semantic chrome update", p99), "performance");
    mounted.unmount();
  });
});
