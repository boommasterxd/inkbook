// @vitest-environment happy-dom
import { sys } from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPresentationFeedbackPositionLifecycle } from "../../../../src/obsidian/feedback";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

afterEach(() => {
  document.body.replaceChildren();
  document.adoptedStyleSheets = [];
  vi.restoreAllMocks();
});

describe("positioned feedback pointer behavior", () => {
  it("keeps the centered operation indicator non-interactive", () => {
    const stylesheet = new CSSStyleSheet();
    stylesheet.replaceSync(
      ["inkbook", "feedback"]
        .map((name) => sys.readFile(sys.resolvePath(`src/obsidian/styles/${name}.css`)) ?? "")
        .join("\n"),
    );
    document.adoptedStyleSheets = [stylesheet];
    const root = document.createElementNS("http://www.w3.org/1999/xhtml", "div") as HTMLDivElement;
    root.className = "inkbook-root";
    const surface = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    surface.className = "inkbook-operation-feedback";
    root.append(surface);
    document.body.append(root);
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(800);
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      left: 0,
      right: 600,
      top: 0,
      height: 100,
      width: 600,
    } as DOMRect);
    const lifecycle = createPresentationFeedbackPositionLifecycle(
      surface,
      root,
      "bottom",
      workSchedulerFromFrames(window),
    );
    expect(surface.style.visibility).toBe("visible");
    expect(window.getComputedStyle(surface).pointerEvents).toBe("none");
    lifecycle.dispose();
  });
});
