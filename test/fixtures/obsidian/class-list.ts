export class FakeClassList {
  readonly #values = new Set<string>();

  public add(...values: string[]): void {
    for (const value of values) this.#values.add(value);
  }

  public contains(value: string): boolean {
    return this.#values.has(value);
  }

  public remove(...values: string[]): void {
    for (const value of values) this.#values.delete(value);
  }
}
