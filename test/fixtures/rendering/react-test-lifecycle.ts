import { afterEach, beforeEach, vi } from "vitest";

export function registerReactTestLifecycle(): (cleanup: () => void) => void {
  const cleanups: Array<() => void> = [];
  const reactEnvironment = window as Window & { IS_REACT_ACT_ENVIRONMENT?: boolean };

  beforeEach(() => {
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    delete reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    vi.restoreAllMocks();
  });

  return (cleanup) => {
    cleanups.push(cleanup);
  };
}
