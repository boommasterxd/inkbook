import { SaveError } from "../save-errors";

export type AutosaveFailureStatus = "conflict" | "debouncing" | "verification-required";

export function classifyAutosaveFailure(error: unknown): AutosaveFailureStatus {
  if (error instanceof SaveError && error.code === "stale-editor-revision") {
    return "debouncing";
  }
  if (error instanceof SaveError && error.code === "external-conflict") return "conflict";
  return "verification-required";
}
