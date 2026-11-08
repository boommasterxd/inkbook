import { expect } from "vitest";

interface ObservedBoundary {
  readonly mock: { readonly calls: readonly unknown[] };
}

/** Bounds real SVG allocation, paint writes and append work between shared admissions. */
export function createSvgDomWorkObserver(
  boundaries: {
    readonly create: ObservedBoundary;
    readonly attributes: ObservedBoundary;
    readonly append: ObservedBoundary;
  },
  limits: { readonly create: number; readonly attributes: number; readonly append: number },
) {
  const read = () =>
    [
      boundaries.create.mock.calls.length,
      boundaries.attributes.mock.calls.length,
      boundaries.append.mock.calls.length,
    ] as const;
  let previous = read();
  return {
    shouldYield: () => boundaries.create.mock.calls.length - previous[0] >= limits.create,
    observe: () => {
      const calls = read();
      expect(calls[0] - previous[0]).toBeLessThanOrEqual(limits.create);
      expect(calls[1] - previous[1]).toBeLessThanOrEqual(limits.attributes);
      expect(calls[2] - previous[2]).toBeLessThanOrEqual(limits.append);
      previous = calls;
    },
  };
}
