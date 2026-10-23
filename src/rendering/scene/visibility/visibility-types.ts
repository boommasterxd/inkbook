export interface BandVisibility {
  readonly count: number;
  readonly ids: readonly (string | undefined)[];
}

export interface VisibilityResult {
  readonly content: BandVisibility;
  readonly highlight: BandVisibility;
}

export interface VisibilityDelta {
  readonly entered: readonly string[];
  readonly exited: readonly string[];
}

export interface VisibilityQueryResult {
  readonly changed: boolean;
  readonly visibility: VisibilityResult;
  readonly delta?: VisibilityDelta;
  readonly pending?: boolean;
}
