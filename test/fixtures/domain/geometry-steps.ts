/** Finish cooperative geometry in correctness tests; work tests advance individual steps. */
export function finishGeometrySteps<Result>(steps: Generator<void, Result>): Result {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
