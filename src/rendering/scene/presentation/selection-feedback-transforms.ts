import type { PreviewTransform } from "../reconciliation/scene-visibility-reconciler";

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
