import type {
  AttachmentFailureReporter,
  MarkdownViewSnapshot,
  ViewResourceFactory,
  WorkspaceBoundary,
  WorkspaceLeafBoundary,
} from "./contracts";
import { LayoutReadiness, type LayoutReadinessToken } from "./layout-readiness";
import { ViewAttachmentOwner } from "./view-attachment-owner";

const DEFAULT_LEAF_LIMIT = 128;
const MAX_LEAF_LIMIT = 256;

export interface ViewAttachmentProbeOptions {
  readonly failures: AttachmentFailureReporter;
  readonly leafLimit?: number;
  readonly resources: ViewResourceFactory;
  readonly workspace: WorkspaceBoundary;
}

export class ViewAttachmentProbe {
  private readonly attachments = new Map<
    WorkspaceLeafBoundary,
    ViewAttachmentOwner
  >();
  private readonly readiness = new LayoutReadiness();
  private disposed = false;
  private started = false;
  private readonly leafLimit: number;

  public constructor(private readonly options: ViewAttachmentProbeOptions) {
    this.leafLimit = normalizeLeafLimit(options.leafLimit);
  }

  public captureLayoutToken(): LayoutReadinessToken | undefined {
    return this.readiness.capture();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.readiness.invalidate();
    for (const attachment of this.attachments.values()) {
      attachment.dispose();
    }
    this.attachments.clear();
  }

  public isLayoutTokenCurrent(token: LayoutReadinessToken): boolean {
    return this.readiness.isCurrent(token);
  }

  public reconcile(): void {
    const token = this.readiness.capture();
    if (token === undefined || this.disposed) {
      return;
    }

    const leaves = this.options.workspace.collectLeaves(this.leafLimit);
    if (!this.readiness.isCurrent(token)) {
      return;
    }

    this.reconcileLeaves(leaves, token);
  }

  public start(): void {
    if (this.started || this.disposed) {
      return;
    }

    this.started = true;
    this.options.workspace.onLayoutReady(() => {
      if (this.readiness.markReady() === undefined || this.disposed) {
        return;
      }
      this.reconcile();
    });
  }

  private readSupportedView(
    leaf: WorkspaceLeafBoundary,
  ): MarkdownViewSnapshot | undefined {
    if (leaf.isDeferred) {
      return undefined;
    }

    try {
      const snapshot = leaf.readView();
      return snapshot.kind === "markdown" ? snapshot : undefined;
    } catch (error: unknown) {
      this.options.failures.report("view-read-failed", error);
      return undefined;
    }
  }

  private reconcileLeaf(
    leaf: WorkspaceLeafBoundary,
    token: LayoutReadinessToken,
  ): void {
    const snapshot = this.readSupportedView(leaf);
    const current = this.attachments.get(leaf);
    if (!this.readiness.isCurrent(token)) {
      return;
    }
    if (snapshot === undefined) {
      current?.dispose();
      this.attachments.delete(leaf);
      return;
    }

    if (current?.matches(snapshot) === true) {
      return;
    }

    current?.dispose();
    const next = ViewAttachmentOwner.create(
      leaf,
      snapshot,
      this.options.resources,
      this.options.failures,
    );
    if (!this.readiness.isCurrent(token) || this.disposed) {
      next?.dispose();
      this.attachments.delete(leaf);
      return;
    }
    if (next === undefined) {
      this.attachments.delete(leaf);
      return;
    }
    this.attachments.set(leaf, next);
  }

  private reconcileLeaves(
    leaves: readonly WorkspaceLeafBoundary[],
    token: LayoutReadinessToken,
  ): void {
    const observed = new Set<WorkspaceLeafBoundary>();
    let count = 0;
    for (const leaf of leaves) {
      if (
        count >= this.leafLimit ||
        !this.readiness.isCurrent(token) ||
        this.disposed
      ) {
        break;
      }
      count += 1;
      if (observed.has(leaf)) {
        continue;
      }
      observed.add(leaf);
      this.reconcileLeaf(leaf, token);
    }

    for (const [leaf, attachment] of this.attachments) {
      if (!this.readiness.isCurrent(token) || this.disposed) {
        break;
      }
      if (!observed.has(leaf)) {
        attachment.dispose();
        this.attachments.delete(leaf);
      }
    }
  }
}

function normalizeLeafLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LEAF_LIMIT;
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LEAF_LIMIT) {
    throw new RangeError(
      `leafLimit must be between 1 and ${String(MAX_LEAF_LIMIT)}`,
    );
  }
  return limit;
}
