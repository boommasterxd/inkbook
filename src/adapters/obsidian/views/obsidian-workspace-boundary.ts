import { MarkdownView, type Workspace, type WorkspaceLeaf } from "obsidian";

import type {
  ElementEnvironment,
  MarkdownSurface,
  ViewSnapshot,
  WorkspaceBoundary,
  WorkspaceLeafBoundary,
} from "./contracts";

export class ObsidianWorkspaceBoundary implements WorkspaceBoundary {
  readonly #leaves = new WeakMap<WorkspaceLeaf, ObsidianLeafBoundary>();

  public constructor(private readonly workspace: Workspace) {}

  public collectLeaves(limit: number): readonly WorkspaceLeafBoundary[] {
    const collected: WorkspaceLeafBoundary[] = [];
    this.workspace.iterateAllLeaves((leaf) => {
      if (collected.length >= limit) return;
      let boundary = this.#leaves.get(leaf);
      if (boundary === undefined) {
        boundary = new ObsidianLeafBoundary(leaf);
        this.#leaves.set(leaf, boundary);
      }
      collected.push(boundary);
    });
    return collected;
  }

  public onLayoutReady(listener: () => void): void {
    this.workspace.onLayoutReady(listener);
  }
}

class ObsidianLeafBoundary implements WorkspaceLeafBoundary {
  public constructor(private readonly leaf: WorkspaceLeaf) {}

  public get isDeferred(): boolean {
    return this.leaf.isDeferred;
  }

  public readView(): ViewSnapshot {
    const view = this.leaf.view;
    if (!(view instanceof MarkdownView)) {
      return {
        kind: view.getViewType() === "bases" ? "bases" : "non-markdown",
      };
    }
    const fileIdentity = view.file?.path;
    if (fileIdentity === undefined || fileIdentity.length === 0) {
      return { kind: "non-markdown" };
    }
    return {
      element: createElementEnvironment(view.containerEl),
      fileIdentity,
      kind: "markdown",
      surface: readSurface(view),
      viewIdentity: view,
    };
  }
}

function readSurface(view: MarkdownView): MarkdownSurface {
  if (view.getMode() === "preview") return "reading";
  return view.getState().source === true ? "source" : "live-preview";
}

function createElementEnvironment(element: HTMLElement): ElementEnvironment {
  return {
    get doc(): Document {
      return element.doc;
    },
    get win(): Window {
      return element.win;
    },
    instanceOf: (value, constructor): boolean =>
      typeof constructor === "function" &&
      value instanceof (constructor as new () => object),
    onWindowMigrated: (listener): { dispose(): void } => {
      const unsubscribe = element.onWindowMigrated(listener);
      return { dispose: unsubscribe };
    },
  };
}
