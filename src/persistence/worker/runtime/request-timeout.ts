/** Owns the cancellable listener for one bounded worker request lifetime. */
export function scheduleRequestTimeout(callback: () => void, milliseconds: number): () => void {
  const signal = AbortSignal.timeout(milliseconds);
  const onTimeout = (): void => callback();
  signal.addEventListener("abort", onTimeout, { once: true });
  return () => signal.removeEventListener("abort", onTimeout);
}
