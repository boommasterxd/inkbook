export const MAXIMUM_PATH_BYTES = 16 * 1024 * 1024;

export function exhaustValidation<T>(steps: Generator<void, T>) {
  let yields = 0;
  let step = steps.next();
  while (!step.done) {
    yields += 1;
    step = steps.next();
  }
  return { result: step.value, yields };
}
