export function createFallbackDeadlineClock(): () => number {
  let reads = 0;
  // Advance only on scheduler observations, independently of machine speed.
  return () => ++reads / 20;
}
