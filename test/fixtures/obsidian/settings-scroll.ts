import { vi } from "vitest";

/** Supplies the production scroll-owner CSS to DOM tests that do not load stylesheets. */
export function mockSettingsScrollOwner(selector: string, overflowY = "scroll"): void {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const style = computedStyle(element);
    if (!element.matches(selector)) return style;
    return new Proxy(style, {
      get(target, key): unknown {
        if (key === "overflowY") return overflowY;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function"
          ? (value as (...arguments_: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  });
}
