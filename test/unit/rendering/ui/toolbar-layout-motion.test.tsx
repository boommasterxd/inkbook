// @vitest-environment happy-dom

import { act, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { useToolbarElementLayoutMotion } from "../../../../src/rendering/ui/toolbar-layout-motion";

const reactEnvironment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };

beforeAll(() => {
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
});

describe("toolbar element layout motion", () => {
  it("animates a handedness mirror from the previous visual position", () => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return domRect(this.dataset.side === "left" ? 120 : 640);
      });
    const container = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;
    document.body.append(container);
    const root = createRoot(container);

    act(() => root.render(<Fixture side="right" />));
    expect(animate).not.toHaveBeenCalled();
    act(() => root.render(<Fixture side="left" />));

    expect(animate).toHaveBeenCalledWith(
      [{ translate: "520px 0" }, { translate: "0 0" }],
      expect.objectContaining({ duration: 120 }),
    );
    act(() => root.unmount());
    rect.mockRestore();
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
    container.remove();
  });
});

function Fixture({ side }: { readonly side: "left" | "right" }) {
  const element = useRef<HTMLDivElement>(null);
  useToolbarElementLayoutMotion(side, element);
  return (
    <div className="inkbook-root" data-inkbook-motion="full">
      <div data-side={side} ref={element} />
    </div>
  );
}

function domRect(left: number): DOMRect {
  return {
    bottom: 48,
    height: 48,
    left,
    right: left + 48,
    toJSON: () => ({}),
    top: 0,
    width: 48,
    x: left,
    y: 0,
  };
}
