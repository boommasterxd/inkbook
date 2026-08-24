import { describe, expect, it } from "vitest";

import { createStableWidthState, observeStableWidth } from "../../../../src/editor/zoom";

describe("stable resize width reduction", () => {
  it("accepts only two consecutive equal positive measurements", () => {
    const initial = createStableWidthState();
    const first = observeStableWidth(initial, 800);
    expect(first.observation).toBeUndefined();
    const accepted = observeStableWidth(first.state, 800);
    expect(accepted.observation).toEqual({ width: 800, accepted: true });
    expect(accepted.state.acceptedWidth).toBe(800);
    expect(initial).toEqual(createStableWidthState());
  });

  it("accepts every positive resize after the initial stable width", () => {
    const first = observeStableWidth(createStableWidthState(), 800);
    const accepted = observeStableWidth(first.state, 800);
    const changed = observeStableWidth(accepted.state, 900);
    expect(changed.observation).toEqual({
      width: 900,
      accepted: true,
    });
    expect(changed.state.acceptedWidth).toBe(900);
  });

  it("discards hidden and non-finite candidates", () => {
    let state = observeStableWidth(createStableWidthState(), 800).state;
    for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const reduction = observeStableWidth(state, width);
      expect(reduction.observation).toBeUndefined();
      expect(reduction.state.candidateWidth).toBeUndefined();
      state = reduction.state;
    }
  });

  it("does not report an unchanged accepted width again", () => {
    const first = observeStableWidth(createStableWidthState(), 800);
    const accepted = observeStableWidth(first.state, 800);
    expect(observeStableWidth(accepted.state, 800).observation).toBeUndefined();
  });
});
