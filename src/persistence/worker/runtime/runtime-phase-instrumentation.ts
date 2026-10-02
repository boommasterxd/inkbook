export interface UnlockPhaseDurations {
  readonly batchAdoptionMs: number;
  readonly inputValidationMs: number;
  readonly modelAdoptionMs: number;
  readonly parserFinalizeMs: number;
  readonly runtimeCopyMs: number;
  readonly totalMs: number;
}

export interface ExportPhaseDurations {
  readonly modelUpdateMs: number;
  readonly serializationMs: number;
  readonly totalMs: number;
}

export const ZERO_UNLOCK_PHASES: UnlockPhaseDurations = Object.freeze({
  batchAdoptionMs: 0,
  inputValidationMs: 0,
  modelAdoptionMs: 0,
  parserFinalizeMs: 0,
  runtimeCopyMs: 0,
  totalMs: 0,
});

export const ZERO_EXPORT_PHASES: ExportPhaseDurations = Object.freeze({
  modelUpdateMs: 0,
  serializationMs: 0,
  totalMs: 0,
});
