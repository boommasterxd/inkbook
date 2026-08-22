const HOSTED_UBUNTU_TIMING_MULTIPLIER = 5;

declare const process: { readonly env: Readonly<Record<string, string | undefined>> };

export function timingBudget(referenceMilliseconds: number): number {
  const profile = process.env["INKBOOK_PERFORMANCE_PROFILE"];
  if (profile === undefined) return referenceMilliseconds;
  if (profile === "hosted-ubuntu") {
    return referenceMilliseconds * HOSTED_UBUNTU_TIMING_MULTIPLIER;
  }
  throw new TypeError(`Unsupported performance profile: ${profile}`);
}
