import { describe, expect, it, vi } from "vitest";

import { createLoadingPlaceholder } from "../../../../../src/obsidian/embeds/preview/loading-placeholder";
import { ColorSchemeBroadcaster } from "../../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../../../fixtures/obsidian/presentation-dom";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

describe("shared placeholder loading feedback", () => {
  it("keeps the surface blank until the common loading indicator is due", () => {
    const { host, runTimer } = placeholderHost();
    let dark = false;
    const scheme = new ColorSchemeBroadcaster({ getColorScheme: () => (dark ? "dark" : "light") });
    const loading = createLoadingPlaceholder(host as unknown as HTMLElement, {
      scheme,
      motion: "reduced",
      workScheduler: workSchedulerFromFrames(host.ownerDocument.defaultView as Window),
    });
    const root = host.children[0]!;
    expect(root.textContent).toBe("");
    expect(root.children).toHaveLength(0);
    expect(root.dataset.inkbookMotion).toBe("reduced");
    runTimer();
    const indicators = host.getElementsByClassName("inkbook-operation-feedback");
    expect(indicators.length).toBe(1);
    expect(indicators.item(0)?.dataset.inkbookOperation).toBe("loading");
    expect(indicators.item(0)?.attributes.get("aria-label")).toBe("Loading drawing");
    dark = true;
    scheme.refresh();
    expect(root.dataset.inkbookScheme).toBe("dark");
    loading.dispose();
    expect(root.children).toHaveLength(0);
    expect(host.getElementsByClassName("inkbook-operation-feedback").length).toBe(0);
    dark = false;
    scheme.refresh();
    expect(root.dataset.inkbookScheme).toBe("dark");
  });

  it("cancels an early completion without showing a delayed or stale spinner", () => {
    const { host, runTimer, clearTimeout } = placeholderHost();
    const scheme = new ColorSchemeBroadcaster({ getColorScheme: () => "light" });
    const loading = createLoadingPlaceholder(host as unknown as HTMLElement, {
      scheme,
      motion: "system",
      workScheduler: workSchedulerFromFrames(host.ownerDocument.defaultView as Window),
    });
    loading.dispose();
    runTimer();
    expect(host.children[0]?.children).toHaveLength(0);
    expect(clearTimeout).toHaveBeenCalledWith(1);
  });
});

function placeholderHost() {
  const host = new FakePresentationElement();
  let timer: (() => void) | undefined;
  vi.spyOn(host.ownerDocument.defaultView!, "setTimeout").mockImplementation((callback) => {
    timer = callback;
    return 1 as unknown as ReturnType<typeof setTimeout>;
  });
  const clearTimeout = vi.spyOn(host.ownerDocument.defaultView!, "clearTimeout");
  return { host, runTimer: () => timer?.(), clearTimeout };
}
