import { describe, expect, it, vi } from "vitest";

import { LivePreviewWidgetHeight } from "../../../../src/obsidian/embeds/live-preview-widget-height";

describe("Live Preview widget height", () => {
  it("retains the latest border-box height and releases its observer", () => {
    const fixture = createFixture();
    const height = new LivePreviewWidgetHeight();
    expect(height.value).toBe(-1);
    const release = height.observe(fixture.root);
    expect(fixture.observe).toHaveBeenCalledExactlyOnceWith(fixture.root, { box: "border-box" });
    fixture.resize(7000);
    expect(height.value).toBe(7000);
    fixture.resize(3500.5);
    expect(height.value).toBe(3500.5);
    release();
    expect(fixture.disconnect).toHaveBeenCalledOnce();
    expect(height.value).toBe(-1);
  });

  it.each([undefined, 0, -1, NaN, Infinity])(
    "keeps the last usable height when a measurement is %s",
    (invalidHeight) => {
      const fixture = createFixture();
      const height = new LivePreviewWidgetHeight();
      const release = height.observe(fixture.root);
      fixture.resize(7000);
      fixture.resize(invalidHeight);
      expect(height.value).toBe(7000);
      release();
    },
  );

  it("ignores measurements belonging to another element", () => {
    const fixture = createFixture();
    const height = new LivePreviewWidgetHeight();
    const release = height.observe(fixture.root);
    fixture.resize(7000, {} as HTMLElement);
    expect(height.value).toBe(-1);
    release();
  });

  it("leaves an unknown estimate when the owner document has no window", () => {
    const height = new LivePreviewWidgetHeight();
    const release = height.observe({ ownerDocument: { defaultView: null } } as HTMLElement);
    expect(height.value).toBe(-1);
    expect(release).not.toThrow();
  });
});

function createFixture() {
  let callback: ResizeObserverCallback | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  const root = {
    ownerDocument: {
      defaultView: {
        ResizeObserver: class {
          observe = observe;
          disconnect = disconnect;
          constructor(listener: ResizeObserverCallback) {
            callback = listener;
          }
        },
      },
    },
  } as unknown as HTMLElement;
  return {
    root,
    observe,
    disconnect,
    resize: (blockSize: number | undefined, target = root) => {
      callback?.(
        [
          {
            target,
            borderBoxSize: blockSize === undefined ? [] : [{ blockSize }],
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
    },
  };
}
