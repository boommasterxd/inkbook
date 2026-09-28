/** Advances a dirty queue by at least one item, then observes the shared deadline. */
export function writeDirtySet(
  dirty: Set<string>,
  deadline: number,
  now: () => number,
  write: (id: string) => void | boolean,
): boolean {
  let processed = 0;
  for (const id of dirty) {
    if (processed > 0 && now() >= deadline) return true;
    if (write(id) === false) return true;
    dirty.delete(id);
    processed += 1;
  }
  return false;
}
