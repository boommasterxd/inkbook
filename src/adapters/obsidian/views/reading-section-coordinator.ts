import type { Disposable } from "./contracts";

const DEFAULT_SECTION_LIMIT = 256;
const MAX_SECTION_LIMIT = 1024;

export interface ReadingSectionReport {
  readonly documentIdentity: string;
  readonly generation: number;
  readonly previewInstanceIdentity: string;
  readonly sectionIdentity: string;
  readonly sourcePath: string;
  readonly trustworthySourceEvidence: boolean;
}

export interface ReadingSectionContext {
  readonly container?: object;
  addChild(child: Disposable): void;
  commitOwnership?(): boolean;
}

export interface ReadingSectionResourceFactory {
  create(
    report: ReadingSectionReport,
    context: ReadingSectionContext,
  ): Disposable;
}

export type ReadingSectionResult =
  | "accepted"
  | "capacity-exceeded"
  | "disposed"
  | "duplicate"
  | "invalid"
  | "ownership-rejected"
  | "stale"
  | "untrusted";

interface SectionRecord {
  readonly child: Disposable;
  readonly generation: number;
}

export class ReadingSectionCoordinator implements Disposable {
  private disposed = false;
  private readonly records = new Map<string, SectionRecord>();
  private readonly sectionLimit: number;

  public constructor(
    private readonly overlay: Disposable,
    private readonly resources: ReadingSectionResourceFactory,
    sectionLimit = DEFAULT_SECTION_LIMIT,
  ) {
    if (
      !Number.isSafeInteger(sectionLimit) ||
      sectionLimit < 1 ||
      sectionLimit > MAX_SECTION_LIMIT
    ) {
      throw new RangeError(
        `sectionLimit must be between 1 and ${String(MAX_SECTION_LIMIT)}`,
      );
    }
    this.sectionLimit = sectionLimit;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    let firstError: unknown;
    for (const record of this.records.values()) {
      try {
        record.child.dispose();
      } catch (error: unknown) {
        firstError ??= error;
      }
    }
    this.records.clear();
    try {
      this.overlay.dispose();
    } catch (error: unknown) {
      firstError ??= error;
    }
    if (firstError !== undefined) {
      throw firstError instanceof Error
        ? firstError
        : new Error("Reading section disposal failed", { cause: firstError });
    }
  }

  public report(
    report: ReadingSectionReport,
    context: ReadingSectionContext,
  ): ReadingSectionResult {
    if (this.disposed) {
      return "disposed";
    }
    if (!isValidReport(report)) {
      return "invalid";
    }
    if (!report.trustworthySourceEvidence) {
      return "untrusted";
    }

    const key = createSectionKey(report);
    const current = this.records.get(key);
    if (current !== undefined && report.generation <= current.generation) {
      return report.generation === current.generation ? "duplicate" : "stale";
    }
    if (current === undefined && this.records.size >= this.sectionLimit) {
      return "capacity-exceeded";
    }

    const child = this.resources.create(report, context);
    try {
      context.addChild(child);
    } catch (error: unknown) {
      child.dispose();
      throw error;
    }
    if (context.commitOwnership?.() === false) {
      child.dispose();
      return "ownership-rejected";
    }
    this.records.set(key, { child, generation: report.generation });
    current?.child.dispose();
    return "accepted";
  }

  public forget(report: ReadingSectionReport): void {
    const key = createSectionKey(report);
    const current = this.records.get(key);
    if (current?.generation === report.generation) this.records.delete(key);
  }

  public remove(report: ReadingSectionReport): void {
    const key = createSectionKey(report);
    const current = this.records.get(key);
    if (current?.generation !== report.generation) return;
    this.records.delete(key);
    current.child.dispose();
  }
}

function createSectionKey(report: ReadingSectionReport): string {
  return JSON.stringify([
    report.documentIdentity,
    report.sourcePath,
    report.previewInstanceIdentity,
    report.sectionIdentity,
  ]);
}

function isValidReport(report: ReadingSectionReport): boolean {
  return (
    report.documentIdentity.length > 0 &&
    report.sourcePath.length > 0 &&
    report.previewInstanceIdentity.length > 0 &&
    report.sectionIdentity.length > 0 &&
    Number.isSafeInteger(report.generation) &&
    report.generation >= 0
  );
}
