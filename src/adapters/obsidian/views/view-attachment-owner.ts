import type {
  AttachmentFailureReporter,
  Disposable,
  MarkdownViewSnapshot,
  ViewResourceContext,
  ViewResourceFactory,
  WorkspaceLeafBoundary,
} from "./contracts";

export class ViewAttachmentOwner implements Disposable {
  private binding: Disposable;
  private disposed = false;
  private document: object;
  private migrationListener: Disposable;
  private window: object;

  private constructor(
    private readonly leaf: WorkspaceLeafBoundary,
    private snapshot: MarkdownViewSnapshot,
    private readonly resources: ViewResourceFactory,
    private readonly failures: AttachmentFailureReporter,
    initial: InitialBinding,
  ) {
    this.binding = initial.binding;
    this.migrationListener = initial.migrationListener;
    this.document = initial.document;
    this.window = initial.window;
  }

  public static create(
    leaf: WorkspaceLeafBoundary,
    snapshot: MarkdownViewSnapshot,
    resources: ViewResourceFactory,
    failures: AttachmentFailureReporter,
  ): ViewAttachmentOwner | undefined {
    let context: ViewResourceContext;
    let binding: Disposable;
    try {
      context = createContext(leaf, snapshot);
      binding = resources.bind(context);
    } catch (error: unknown) {
      failures.report("bind-failed", error);
      return undefined;
    }

    let owner: ViewAttachmentOwner | undefined;
    try {
      const listener = snapshot.element.onWindowMigrated(() => {
        owner?.rebindAfterMigration(failures);
      });
      owner = new ViewAttachmentOwner(leaf, snapshot, resources, failures, {
        binding,
        document: context.document,
        migrationListener: listener,
        window: context.window,
      });
      owner.rebindAfterMigration(failures);
      if (owner.isDisposed()) return undefined;
      return owner;
    } catch (error: unknown) {
      disposeResource(binding, failures);
      failures.report("migration-listener-failed", error);
      return undefined;
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    disposeResource(this.migrationListener, this.failures);
    disposeResource(this.binding, this.failures);
  }

  public matches(snapshot: MarkdownViewSnapshot): boolean {
    return (
      !this.disposed &&
      this.snapshot.viewIdentity === snapshot.viewIdentity &&
      this.snapshot.fileIdentity === snapshot.fileIdentity &&
      this.snapshot.surface === snapshot.surface
    );
  }

  public rebindAfterMigration(failures: AttachmentFailureReporter): void {
    if (this.disposed) {
      return;
    }

    const nextDocument = this.snapshot.element.doc;
    const nextWindow = this.snapshot.element.win;
    if (nextDocument === this.document && nextWindow === this.window) {
      return;
    }

    disposeResource(this.binding, failures);
    try {
      const binding = this.resources.bind(
        createContext(this.leaf, this.snapshot),
      );
      if (this.isDisposed()) {
        disposeResource(binding, failures);
        return;
      }
      this.binding = binding;
      this.document = nextDocument;
      this.window = nextWindow;
    } catch (error: unknown) {
      this.disposed = true;
      disposeResource(this.migrationListener, failures);
      failures.report("bind-failed", error);
    }
  }

  private isDisposed(): boolean {
    return this.disposed;
  }
}

interface InitialBinding {
  readonly binding: Disposable;
  readonly document: object;
  readonly migrationListener: Disposable;
  readonly window: object;
}

function createContext(
  leaf: WorkspaceLeafBoundary,
  snapshot: MarkdownViewSnapshot,
): ViewResourceContext {
  return {
    document: snapshot.element.doc,
    element: snapshot.element,
    fileIdentity: snapshot.fileIdentity,
    leaf,
    surface: snapshot.surface,
    viewIdentity: snapshot.viewIdentity,
    window: snapshot.element.win,
  };
}

function disposeResource(
  resource: Disposable,
  failures: AttachmentFailureReporter,
): void {
  try {
    resource.dispose();
  } catch (error: unknown) {
    failures.report("dispose-failed", error);
  }
}
