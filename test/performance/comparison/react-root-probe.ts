interface RootProbe {
  renders: number;
  unmounts: number;
}

const key = Symbol.for("inkbook.performance.react-root-probe");
const host = window as typeof window & { [key]?: RootProbe };

export function readRootProbe(): RootProbe {
  return (host[key] ??= { renders: 0, unmounts: 0 });
}

export function resetRootProbe(): void {
  host[key] = { renders: 0, unmounts: 0 };
}

/** Matches the semantic-publication probe used by the existing chrome benchmark. */
export function createRoot(): { render: () => void; unmount: () => void } {
  return {
    render: () => {
      readRootProbe().renders += 1;
    },
    unmount: () => {
      readRootProbe().unmounts += 1;
    },
  };
}
