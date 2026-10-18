import { SpatialMap } from "./spatial-map";

export class SpatialSet<Value> {
  public constructor(private values = new SpatialMap<Value, true>()) {}

  public get size(): number {
    return this.values.size;
  }

  public fork(): SpatialSet<Value> {
    return new SpatialSet(this.values.fork());
  }

  public add(value: Value): this {
    this.values.set(value, true);
    return this;
  }

  public delete(value: Value): boolean {
    return this.values.delete(value);
  }

  public [Symbol.iterator](): MapIterator<Value> {
    return this.values.keys();
  }
}
