export type EditorRange = Readonly<{ from: number; to: number }>;

export type NativeSelectionObservation = Readonly<{
  claimedByPlugin: boolean;
  defaultPrevented: boolean;
  before: EditorRange;
  after: EditorRange;
}>;

export type CodeMirrorViewportObservation = Readonly<{
  documentLength: number;
  visibleRanges: readonly EditorRange[];
  queriedRanges: readonly EditorRange[];
  mountedRanges: readonly EditorRange[];
  overscanCodeUnits: number;
  forcedOffscreenMount: boolean;
  projectionRequestsInFrame: number;
}>;

type CompositionPhase = "start" | "update" | "end";

export type CompositionEventObservation = Readonly<{
  phase: CompositionPhase;
  claimedByPlugin: boolean;
  defaultPrevented: boolean;
}>;

export type ImeObservation = Readonly<{
  events: readonly CompositionEventObservation[];
  nativeInputApplied: boolean;
}>;

export type SoftwareKeyboardObservation = Readonly<{
  beforeInputObserved: boolean;
  inputObserved: boolean;
  claimedByPlugin: boolean;
  defaultPrevented: boolean;
  nativeInputApplied: boolean;
}>;

export type EditorInputProbeReport = Readonly<{
  nativeTextSelectionPasses: boolean;
  codeMirrorVirtualizationPasses: boolean;
  imePasses: boolean;
  softwareKeyboardPasses: boolean;
  complete: boolean;
  disposed: boolean;
}>;

export const EDITOR_INPUT_PROBE_LIMITS = {
  maxRangesPerObservation: 16,
  maxCompositionEvents: 32,
  maxOverscanCodeUnits: 100_000,
} as const;

const MIN_COMPOSITION_EVENTS = 2;
const FIRST_EVENT_INDEX = 0;
const LAST_EVENT_OFFSET = -1;

export interface EditorInputProbeContract {
  observeNativeTextSelection(observation: NativeSelectionObservation): boolean;
  observeCodeMirrorViewport(
    observation: CodeMirrorViewportObservation,
  ): boolean;
  observeIme(observation: ImeObservation): boolean;
  observeSoftwareKeyboard(observation: SoftwareKeyboardObservation): boolean;
  report(): EditorInputProbeReport;
  dispose(): void;
}

export class EditorInputProbe implements EditorInputProbeContract {
  #nativeTextSelectionPasses: boolean | undefined;
  #codeMirrorVirtualizationPasses: boolean | undefined;
  #imePasses: boolean | undefined;
  #softwareKeyboardPasses: boolean | undefined;
  #disposed = false;

  observeNativeTextSelection(observation: NativeSelectionObservation): boolean {
    if (this.#disposed) return false;
    const passes =
      !observation.claimedByPlugin &&
      !observation.defaultPrevented &&
      isRange(observation.before, Number.MAX_SAFE_INTEGER) &&
      isRange(observation.after, Number.MAX_SAFE_INTEGER) &&
      (observation.before.from !== observation.after.from ||
        observation.before.to !== observation.after.to);
    this.#nativeTextSelectionPasses = mergeProof(
      this.#nativeTextSelectionPasses,
      passes,
    );
    return passes;
  }

  observeCodeMirrorViewport(
    observation: CodeMirrorViewportObservation,
  ): boolean {
    if (this.#disposed) return false;
    const passes = isBoundedViewportObservation(observation);
    this.#codeMirrorVirtualizationPasses = mergeProof(
      this.#codeMirrorVirtualizationPasses,
      passes,
    );
    return passes;
  }

  observeIme(observation: ImeObservation): boolean {
    if (this.#disposed) return false;
    const passes = isNativeImeSequence(observation);
    this.#imePasses = mergeProof(this.#imePasses, passes);
    return passes;
  }

  observeSoftwareKeyboard(observation: SoftwareKeyboardObservation): boolean {
    if (this.#disposed) return false;
    const passes =
      observation.beforeInputObserved &&
      observation.inputObserved &&
      !observation.claimedByPlugin &&
      !observation.defaultPrevented &&
      observation.nativeInputApplied;
    this.#softwareKeyboardPasses = mergeProof(
      this.#softwareKeyboardPasses,
      passes,
    );
    return passes;
  }

  report(): EditorInputProbeReport {
    const nativeTextSelectionPasses = this.#nativeTextSelectionPasses === true;
    const codeMirrorVirtualizationPasses =
      this.#codeMirrorVirtualizationPasses === true;
    const imePasses = this.#imePasses === true;
    const softwareKeyboardPasses = this.#softwareKeyboardPasses === true;
    return {
      nativeTextSelectionPasses,
      codeMirrorVirtualizationPasses,
      imePasses,
      softwareKeyboardPasses,
      complete:
        nativeTextSelectionPasses &&
        codeMirrorVirtualizationPasses &&
        imePasses &&
        softwareKeyboardPasses,
      disposed: this.#disposed,
    };
  }

  dispose(): void {
    this.#disposed = true;
  }
}

function isBoundedViewportObservation(
  observation: CodeMirrorViewportObservation,
): boolean {
  const { maxRangesPerObservation, maxOverscanCodeUnits } =
    EDITOR_INPUT_PROBE_LIMITS;
  if (
    !Number.isSafeInteger(observation.documentLength) ||
    observation.documentLength < 0 ||
    !Number.isSafeInteger(observation.overscanCodeUnits) ||
    observation.overscanCodeUnits < 0 ||
    observation.overscanCodeUnits > maxOverscanCodeUnits ||
    observation.visibleRanges.length === 0 ||
    observation.visibleRanges.length > maxRangesPerObservation ||
    observation.queriedRanges.length > maxRangesPerObservation ||
    observation.mountedRanges.length > maxRangesPerObservation ||
    observation.forcedOffscreenMount ||
    !Number.isSafeInteger(observation.projectionRequestsInFrame) ||
    observation.projectionRequestsInFrame < 0 ||
    observation.projectionRequestsInFrame > 1
  ) {
    return false;
  }
  const validRanges = [
    ...observation.visibleRanges,
    ...observation.queriedRanges,
    ...observation.mountedRanges,
  ].every((range) => isRange(range, observation.documentLength));
  return (
    validRanges &&
    observation.queriedRanges.every((range) =>
      isWithinOverscan(
        range,
        observation.visibleRanges,
        observation.overscanCodeUnits,
        observation.documentLength,
      ),
    ) &&
    observation.mountedRanges.every((range) =>
      overlapsAny(range, observation.visibleRanges),
    )
  );
}

function isNativeImeSequence(observation: ImeObservation): boolean {
  const events = observation.events;
  if (
    events.length < MIN_COMPOSITION_EVENTS ||
    events.length > EDITOR_INPUT_PROBE_LIMITS.maxCompositionEvents ||
    events[FIRST_EVENT_INDEX]?.phase !== "start" ||
    events.at(LAST_EVENT_OFFSET)?.phase !== "end" ||
    !observation.nativeInputApplied
  ) {
    return false;
  }
  return events.every((event, index) => {
    let validPhase = event.phase === "update";
    if (index === FIRST_EVENT_INDEX) validPhase = event.phase === "start";
    if (index === events.length - 1) validPhase = event.phase === "end";
    return validPhase && !event.claimedByPlugin && !event.defaultPrevented;
  });
}

function isRange(range: EditorRange, documentLength: number): boolean {
  return (
    Number.isSafeInteger(range.from) &&
    Number.isSafeInteger(range.to) &&
    range.from >= 0 &&
    range.from <= range.to &&
    range.to <= documentLength
  );
}

function isWithinOverscan(
  range: EditorRange,
  visibleRanges: readonly EditorRange[],
  overscan: number,
  documentLength: number,
): boolean {
  return visibleRanges.some(
    (visible) =>
      range.from >= Math.max(0, visible.from - overscan) &&
      range.to <= Math.min(documentLength, visible.to + overscan),
  );
}

function overlapsAny(
  range: EditorRange,
  visibleRanges: readonly EditorRange[],
): boolean {
  return visibleRanges.some(
    (visible) => range.from <= visible.to && range.to >= visible.from,
  );
}

function mergeProof(previous: boolean | undefined, current: boolean): boolean {
  return previous === undefined ? current : previous && current;
}
