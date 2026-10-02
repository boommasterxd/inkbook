const REQUEST_TYPES = new Set([
  "clipboard-decode",
  "clipboard-encode",
  "clipboard-plan-paste",
  "export-full-wire",
  "export-incremental-wire",
  "model-sync-full-wire",
  "model-sync-incremental-wire",
  "prepare-scene-paths",
  "unlock",
  "verify-output",
]);

const RESULT_TYPES = new Set([
  "clipboard-decode-success-wire",
  "clipboard-encode-success-wire",
  "clipboard-plan-paste-success-wire",
  "export-failure",
  "export-success-wire",
  "model-sync-success",
  "prepare-scene-paths-success",
  "runtime-failure",
  "unlock-success",
  "verify-output-success",
]);

export function isRuntimeWireRequestType(value: string): boolean {
  return REQUEST_TYPES.has(value);
}

export function isRuntimeWireResultType(value: string): boolean {
  return RESULT_TYPES.has(value);
}
