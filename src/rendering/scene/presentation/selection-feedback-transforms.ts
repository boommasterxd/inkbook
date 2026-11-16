import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { MountedSceneElement } from "../content/mounted-element";
import { composeMatrices } from "./selection-run-residuals";

export function selectionWorldTransform(
  entry: MountedSceneElement,
  parentTransform: string | null,
  parentMatrix: NonNullable<PreviewTransform["matrix"]>,
  options: {
    readonly exception: boolean;
    readonly committing: boolean;
    readonly version: number;
    readonly zoom: number;
  },
): PreviewTransform {
  return {
    transform: options.exception
      ? entry.appliedPreviewTransform
      : [parentTransform, entry.appliedPreviewTransform].filter(Boolean).join(" ") ||
        (options.committing ? "matrix(1 0 0 1 0 0)" : null),
    matrix: options.exception
      ? entry.appliedPreviewMatrix
      : entry.appliedPreviewMatrix === undefined
        ? undefined
        : composeMatrices(parentMatrix, entry.appliedPreviewMatrix),
    version: options.version,
    strokeWidthScale: options.zoom,
  };
}

export function selectionExceptionElements(
  elements: ReadonlyMap<string, InkElementV1>,
  ids: ReadonlySet<string>,
): ReadonlyMap<string, InkElementV1> {
  const result = new Map<string, InkElementV1>();
  for (const id of ids) {
    const element = elements.get(id);
    if (element !== undefined) result.set(id, element);
  }
  return result;
}

export function selectionExceptionTransforms(
  ids: ReadonlySet<string>,
  read: (id: string) => PreviewTransform | undefined,
): ReadonlyMap<string, PreviewTransform> {
  const result = new Map<string, PreviewTransform>();
  for (const id of ids) {
    const preview = read(id);
    if (preview !== undefined) result.set(id, preview);
  }
  return result;
}

/** Exposes one shared feedback owner without copying a transform record per member. */
export class SelectionFeedbackTransforms implements ReadonlyMap<string, PreviewTransform> {
  public constructor(
    private readonly source: {
      readonly size: () => number;
      readonly ids: () => Iterable<string>;
      readonly get: (id: string) => PreviewTransform | undefined;
    },
  ) {}
  public get size(): number {
    return this.source.size();
  }
  public get(id: string): PreviewTransform | undefined {
    return this.source.get(id);
  }
  public has(id: string): boolean {
    return this.get(id) !== undefined;
  }
  public *entries(): MapIterator<[string, PreviewTransform]> {
    for (const id of this.source.ids()) {
      const value = this.get(id);
      if (value !== undefined) yield [id, value];
    }
  }
  public *keys(): MapIterator<string> {
    for (const [id] of this) yield id;
  }
  public *values(): MapIterator<PreviewTransform> {
    for (const [, value] of this) yield value;
  }
  public forEach(
    callback: (
      value: PreviewTransform,
      key: string,
      map: ReadonlyMap<string, PreviewTransform>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [id, value] of this) callback.call(thisArg, value, id, this);
  }
  public [Symbol.iterator](): MapIterator<[string, PreviewTransform]> {
    return this.entries();
  }
}
