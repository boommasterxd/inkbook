import { describe, expect, it, vi } from "vitest";

import type {
  AttachmentFailure,
  Disposable,
  ElementEnvironment,
  MarkdownSurface,
  ViewResourceContext,
  ViewSnapshot,
  WorkspaceBoundary,
  WorkspaceLeafBoundary,
} from "../../../../src/adapters/obsidian/views";
import { ViewAttachmentProbe } from "../../../../src/adapters/obsidian/views";

const TWO = 2;
const THREE = 3;
const ABOVE_MAX_LEAF_LIMIT = 257;

class Environment implements ElementEnvironment {
  public doc: object = { name: "main-document" };
  public win: object = { name: "main-window" };
  private readonly listeners = new Set<() => void>();

  public instanceOf(value: unknown, constructor: object): boolean {
    return value === constructor;
  }

  public migrate(doc: object, win: object): void {
    this.doc = doc;
    this.win = win;
    for (const listener of this.listeners) {
      listener();
    }
  }

  public onWindowMigrated(listener: () => void): Disposable {
    this.listeners.add(listener);
    return disposable(() => this.listeners.delete(listener));
  }

  public subscriberCount(): number {
    return this.listeners.size;
  }
}

class Leaf implements WorkspaceLeafBoundary {
  public isDeferred = false;
  public readCount = 0;

  public constructor(public snapshot: ViewSnapshot) {}

  public readView(): ViewSnapshot {
    this.readCount += 1;
    return this.snapshot;
  }
}

class Workspace implements WorkspaceBoundary {
  public collectCount = 0;
  public lastLimit: number | undefined;
  private layoutListener: (() => void) | undefined;

  public constructor(public leaves: readonly WorkspaceLeafBoundary[]) {}

  public collectLeaves(limit: number): readonly WorkspaceLeafBoundary[] {
    this.collectCount += 1;
    this.lastLimit = limit;
    return this.leaves;
  }

  public fireLayoutReady(): void {
    this.layoutListener?.();
  }

  public onLayoutReady(listener: () => void): void {
    this.layoutListener = listener;
  }
}

interface Harness {
  readonly binds: ViewResourceContext[];
  readonly disposals: ViewResourceContext[];
  readonly failures: AttachmentFailure[];
  readonly probe: ViewAttachmentProbe;
}

function createHarness(
  workspace: Workspace,
  leafLimit?: number,
  bindFailure?: Error,
): Harness {
  const binds: ViewResourceContext[] = [];
  const disposals: ViewResourceContext[] = [];
  const failures: AttachmentFailure[] = [];
  const probe = new ViewAttachmentProbe({
    failures: {
      report: (failure: AttachmentFailure): void => {
        failures.push(failure);
      },
    },
    ...(leafLimit === undefined ? {} : { leafLimit }),
    resources: {
      bind: (context: ViewResourceContext): Disposable => {
        if (bindFailure !== undefined) {
          throw bindFailure;
        }
        binds.push(context);
        return disposable(() => disposals.push(context));
      },
    },
    workspace,
  });
  return { binds, disposals, failures, probe };
}

function markdown(
  surface: MarkdownSurface,
  fileIdentity: string,
  viewIdentity: object = {},
  element = new Environment(),
): ViewSnapshot {
  return {
    element,
    fileIdentity,
    kind: "markdown",
    surface,
    viewIdentity,
  };
}

function disposable(action: () => unknown): Disposable {
  let disposed = false;
  return {
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      action();
    },
  };
}

describe("ViewAttachmentProbe", () => {
  it("waits for layout readiness and invalidates its readiness token on unload", () => {
    const workspace = new Workspace([new Leaf(markdown("source", "a.md"))]);
    const { binds, probe } = createHarness(workspace);

    probe.start();
    probe.reconcile();
    expect(workspace.collectCount).toBe(0);
    expect(probe.captureLayoutToken()).toBeUndefined();

    workspace.fireLayoutReady();
    const token = probe.captureLayoutToken();
    expect(token).toBeDefined();
    expect(binds).toHaveLength(1);
    if (token === undefined) {
      throw new Error("Expected a layout readiness token");
    }
    expect(probe.isLayoutTokenCurrent(token)).toBe(true);

    probe.dispose();
    expect(probe.isLayoutTokenCurrent(token)).toBe(false);
    workspace.fireLayoutReady();
    expect(binds).toHaveLength(1);
  });

  it("attaches one independent owner for each Live Preview, Source, and Reading pane", () => {
    const leaves = [
      new Leaf(markdown("live-preview", "shared.md")),
      new Leaf(markdown("source", "shared.md")),
      new Leaf(markdown("reading", "other.md")),
    ];
    const workspace = new Workspace(leaves);
    const { binds, probe } = createHarness(workspace);

    probe.start();
    workspace.fireLayoutReady();

    expect(binds.map(({ surface }) => surface)).toEqual([
      "live-preview",
      "source",
      "reading",
    ]);
    expect(binds[0]?.leaf).not.toBe(binds[1]?.leaf);
    expect(binds[0]?.fileIdentity).toBe(binds[1]?.fileIdentity);
  });

  it("passively skips deferred, Bases, and non-Markdown leaves", () => {
    const deferred = new Leaf(markdown("source", "deferred.md"));
    deferred.isDeferred = true;
    const bases = new Leaf({ kind: "bases" });
    const nonMarkdown = new Leaf({ kind: "non-markdown" });
    const workspace = new Workspace([deferred, bases, nonMarkdown]);
    const { binds, probe } = createHarness(workspace);

    probe.start();
    workspace.fireLayoutReady();

    expect(binds).toHaveLength(0);
    expect(deferred.readCount).toBe(0);
    expect(bases.readCount).toBe(1);
    expect(nonMarkdown.readCount).toBe(1);
  });

  it("replaces only the owner whose concrete view, mode, or file changes", () => {
    const firstIdentity = {};
    const stableIdentity = {};
    const changed = new Leaf(markdown("source", "a.md", firstIdentity));
    const stable = new Leaf(markdown("reading", "b.md", stableIdentity));
    const workspace = new Workspace([changed, stable]);
    const { binds, disposals, probe } = createHarness(workspace);
    probe.start();
    workspace.fireLayoutReady();

    changed.snapshot = markdown("live-preview", "c.md", {});
    probe.reconcile();

    expect(binds).toHaveLength(THREE);
    expect(disposals).toHaveLength(1);
    expect(disposals[0]?.viewIdentity).toBe(firstIdentity);
    expect(binds[2]?.fileIdentity).toBe("c.md");
    expect(
      binds.filter(({ viewIdentity }) => viewIdentity === stableIdentity),
    ).toHaveLength(1);
  });
});

describe("ViewAttachmentProbe lifecycle boundaries", () => {
  it("disposes detached leaves and unloads every remaining owner exactly once", () => {
    const first = new Leaf(markdown("source", "a.md"));
    const second = new Leaf(markdown("reading", "b.md"));
    const workspace = new Workspace([first, second]);
    const { disposals, probe } = createHarness(workspace);
    probe.start();
    workspace.fireLayoutReady();

    workspace.leaves = [second];
    probe.reconcile();
    probe.dispose();
    probe.dispose();

    expect(disposals).toHaveLength(TWO);
  });

  it("rebinds pop-out resources to the migrated element document and window", () => {
    const environment = new Environment();
    const leaf = new Leaf(markdown("source", "a.md", {}, environment));
    const workspace = new Workspace([leaf]);
    const { binds, disposals, probe } = createHarness(workspace);
    probe.start();
    workspace.fireLayoutReady();

    const popoutDocument = { name: "popout-document" };
    const popoutWindow = { name: "popout-window" };
    environment.migrate(popoutDocument, popoutWindow);

    expect(disposals).toHaveLength(1);
    expect(binds).toHaveLength(TWO);
    expect(binds[1]?.document).toBe(popoutDocument);
    expect(binds[1]?.window).toBe(popoutWindow);
    probe.dispose();
    expect(environment.subscriberCount()).toBe(0);
  });

  it("ignores duplicate leaves and enforces the configured discovery bound", () => {
    const first = new Leaf(markdown("source", "a.md"));
    const second = new Leaf(markdown("source", "b.md"));
    const workspace = new Workspace([first, first, second]);
    const { binds, probe } = createHarness(workspace, TWO);
    probe.start();
    workspace.fireLayoutReady();

    expect(workspace.lastLimit).toBe(TWO);
    expect(binds).toHaveLength(1);
    expect(() => createHarness(workspace, 0)).toThrow(RangeError);
    expect(() => createHarness(workspace, ABOVE_MAX_LEAF_LIMIT)).toThrow(
      RangeError,
    );
  });

  it("fails closed when reading a view or binding resources fails", () => {
    const brokenLeaf: WorkspaceLeafBoundary = {
      isDeferred: false,
      readView: (): ViewSnapshot => {
        throw new Error("host view unavailable");
      },
    };
    const workspace = new Workspace([brokenLeaf]);
    const first = createHarness(workspace);
    first.probe.start();
    workspace.fireLayoutReady();
    expect(first.failures).toEqual(["view-read-failed"]);

    const bindWorkspace = new Workspace([new Leaf(markdown("source", "a.md"))]);
    const second = createHarness(
      bindWorkspace,
      undefined,
      new Error("bind failed"),
    );
    second.probe.start();
    bindWorkspace.fireLayoutReady();
    expect(second.failures).toEqual(["bind-failed"]);
    expect(second.binds).toHaveLength(0);
  });
});

describe("ViewAttachmentProbe unload races", () => {
  it("registers layout readiness only once", () => {
    const workspace = new Workspace([]);
    const readySpy = vi.spyOn(workspace, "onLayoutReady");
    const { probe } = createHarness(workspace);
    probe.start();
    probe.start();
    expect(readySpy).toHaveBeenCalledTimes(1);
  });

  it("does not retain a resource created by a reentrant unload", () => {
    const workspace = new Workspace([new Leaf(markdown("source", "a.md"))]);
    const disposal = vi.fn();
    const holder: { probe?: ViewAttachmentProbe } = {};
    const probe = new ViewAttachmentProbe({
      failures: { report: (): void => undefined },
      resources: {
        bind: (): Disposable => {
          holder.probe?.dispose();
          return disposable(disposal);
        },
      },
      workspace,
    });
    holder.probe = probe;

    probe.start();
    workspace.fireLayoutReady();
    expect(disposal).toHaveBeenCalledTimes(1);
  });

  it("continues unload when a child disposer fails", () => {
    const environment = new Environment();
    const workspace = new Workspace([
      new Leaf(markdown("source", "a.md", {}, environment)),
    ]);
    const failures: AttachmentFailure[] = [];
    const probe = new ViewAttachmentProbe({
      failures: {
        report: (failure: AttachmentFailure): void => {
          failures.push(failure);
        },
      },
      resources: {
        bind: (): Disposable => ({
          dispose: (): void => {
            throw new Error("disposal failed");
          },
        }),
      },
      workspace,
    });
    probe.start();
    workspace.fireLayoutReady();

    expect(() => probe.dispose()).not.toThrow();
    expect(failures).toContain("dispose-failed");
    expect(environment.subscriberCount()).toBe(0);
  });
});
