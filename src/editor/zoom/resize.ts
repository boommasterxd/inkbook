export interface StableWidthState {
  readonly candidateWidth: number | undefined;
  readonly candidateFrames: number;
  readonly acceptedWidth: number | undefined;
}

interface WidthObservation {
  readonly width: number;
  readonly accepted: true;
}

export interface StableWidthReduction {
  readonly state: StableWidthState;
  readonly observation: WidthObservation | undefined;
}

export function createStableWidthState(): StableWidthState {
  return { candidateWidth: undefined, candidateFrames: 0, acceptedWidth: undefined };
}

export function observeStableWidth(state: StableWidthState, width: number): StableWidthReduction {
  if (!Number.isFinite(width) || width <= 0) {
    return {
      state: { ...state, candidateWidth: undefined, candidateFrames: 0 },
      observation: undefined,
    };
  }
  if (state.acceptedWidth !== undefined && state.acceptedWidth !== width) {
    return {
      state: { acceptedWidth: width, candidateFrames: 1, candidateWidth: width },
      observation: { width, accepted: true },
    };
  }
  const candidateFrames = state.candidateWidth === width ? state.candidateFrames + 1 : 1;
  const candidateState = { ...state, candidateWidth: width, candidateFrames };
  if (candidateFrames < 2 || state.acceptedWidth === width) {
    return { state: candidateState, observation: undefined };
  }
  return {
    state: { ...candidateState, acceptedWidth: width },
    observation: { width, accepted: true },
  };
}
