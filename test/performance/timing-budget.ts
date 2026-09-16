declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

export type PerformanceMode = "reference" | "contracts" | "measurement";

export function performanceMode(): PerformanceMode {
  const profile = process.env["INKBOOK_PERFORMANCE_PROFILE"];
  if (profile !== undefined) {
    throw new TypeError(
      `Unsupported performance profile: ${profile}. Timing multipliers were removed.`,
    );
  }
  const mode = process.env["INKBOOK_PERFORMANCE_MODE"] ?? "reference";
  if (mode !== "reference" && mode !== "contracts" && mode !== "measurement") {
    throw new TypeError(`Unsupported performance mode: ${mode}`);
  }
  return mode;
}

export function timingBudget(referenceMilliseconds: number): number {
  performanceMode();
  if (!Number.isFinite(referenceMilliseconds) || referenceMilliseconds <= 0) {
    throw new TypeError("Timing budgets must be finite and positive.");
  }
  return referenceMilliseconds;
}
