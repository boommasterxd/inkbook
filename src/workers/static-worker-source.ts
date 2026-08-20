declare const __INKBOOK_STATIC_WORKER_SOURCE__: string | undefined;

export function readStaticSharedWorkerSource(): string {
  if (
    typeof __INKBOOK_STATIC_WORKER_SOURCE__ !== "string" ||
    __INKBOOK_STATIC_WORKER_SOURCE__.length === 0
  ) {
    throw new Error("The static worker payload is unavailable.");
  }
  return __INKBOOK_STATIC_WORKER_SOURCE__;
}
