// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OverflowMenu } from "../../../../src/rendering/ui/overflow-menu";

const reactEnvironment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeAll(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

beforeEach(installCreateDiv);

afterEach(() => document.body.replaceChildren());

describe("overflow menu", () => {
  it("opens the icon-labelled background submenu on hover and keyboard focus", () => {
    const onBackgroundTypeChange = vi.fn();
    const container = document.body.createDiv();
    const root = createRoot(container);
    act(() => {
      root.render(
        <OverflowMenu
          background={{ spacing: "m", type: "lines" }}
          onAction={vi.fn()}
          onBackgroundSpacingChange={vi.fn()}
          onBackgroundTypeChange={onBackgroundTypeChange}
          renderIcon={(element, icon) => element.setAttribute("data-icon", icon)}
          state={{
            arrange: {
              "bring-forward": false,
              "bring-to-front": false,
              "send-backward": false,
              "send-to-back": false,
            },
            canEraseAll: true,
            hasSelection: false,
          }}
        />,
      );
    });

    const background = buttonWithText(container, "Background");
    expect(background.getAttribute("aria-haspopup")).toBe("menu");
    expect(background.querySelector("[data-icon='table-2']")).not.toBeNull();

    void act(() => background.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    const submenu = container.querySelector<HTMLElement>(".inkbook-overflow-submenu");
    expect(submenu?.getAttribute("role")).toBe("menu");
    expect(buttonWithText(container, "Lines").getAttribute("aria-checked")).toBe("true");
    expect(submenu?.querySelectorAll(".inkbook-overflow-menu-icon").length).toBeGreaterThan(0);
    expect(
      buttonWithText(container, "Squares").querySelector("[data-icon='table-2']"),
    ).not.toBeNull();

    act(() => buttonWithText(container, "Squares").click());
    expect(onBackgroundTypeChange).toHaveBeenCalledWith("squares");
    act(() => root.unmount());
    container.remove();
  });

  it("groups document and destructive actions with icons", () => {
    const onAction = vi.fn();
    const container = document.body.createDiv();
    const root = createRoot(container);
    act(() => {
      root.render(
        <OverflowMenu
          background={{ spacing: null, type: "none" }}
          onAction={onAction}
          onBackgroundSpacingChange={vi.fn()}
          onBackgroundTypeChange={vi.fn()}
          renderIcon={(element, icon) => element.setAttribute("data-icon", icon)}
          state={{
            arrange: {
              "bring-forward": true,
              "bring-to-front": true,
              "send-backward": true,
              "send-to-back": true,
            },
            canEraseAll: true,
            hasSelection: true,
          }}
        />,
      );
    });

    expect(container.querySelectorAll("[role='separator']")).toHaveLength(3);
    for (const label of ["Copy embed", "Erase all", "Delete embed"]) {
      expect(buttonWithText(container, label).querySelector("[data-icon]")).not.toBeNull();
    }
    expect(buttonWithText(container, "Delete embed").dataset.destructive).toBe("true");
    act(() => buttonWithText(container, "Copy embed").click());
    expect(onAction).toHaveBeenCalledWith("copy-embed");
    act(() => root.unmount());
    container.remove();
  });
});

function buttonWithText(container: Element, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (button === undefined) throw new Error(`Expected button: ${text}`);
  return button;
}

function installCreateDiv(): void {
  document.body.createDiv = () => {
    const element = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    document.body.append(element);
    return element;
  };
}
