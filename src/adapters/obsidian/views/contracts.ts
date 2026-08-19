export interface Disposable {
  dispose(): void;
}

export type MarkdownSurface = "live-preview" | "reading" | "source";

export interface ElementEnvironment {
  readonly doc: object;
  readonly win: object;
  instanceOf(value: unknown, constructor: object): boolean;
  onWindowMigrated(listener: () => void): Disposable;
}

export interface MarkdownViewSnapshot {
  readonly element: ElementEnvironment;
  readonly fileIdentity: string;
  readonly kind: "markdown";
  readonly surface: MarkdownSurface;
  readonly viewIdentity: object;
}

interface UnsupportedViewSnapshot {
  readonly kind: "bases" | "non-markdown";
}

export type ViewSnapshot = MarkdownViewSnapshot | UnsupportedViewSnapshot;

export interface WorkspaceLeafBoundary {
  readonly isDeferred: boolean;
  readView(): ViewSnapshot;
}

export interface WorkspaceBoundary {
  collectLeaves(limit: number): readonly WorkspaceLeafBoundary[];
  onLayoutReady(listener: () => void): void;
}

export interface ViewResourceContext {
  readonly document: object;
  readonly element: ElementEnvironment;
  readonly fileIdentity: string;
  readonly leaf: WorkspaceLeafBoundary;
  readonly surface: MarkdownSurface;
  readonly viewIdentity: object;
  readonly window: object;
}

export interface ViewResourceFactory {
  bind(context: ViewResourceContext): Disposable;
}

export type AttachmentFailure =
  | "bind-failed"
  | "dispose-failed"
  | "migration-listener-failed"
  | "view-read-failed";

export interface AttachmentFailureReporter {
  report(failure: AttachmentFailure, error: unknown): void;
}
