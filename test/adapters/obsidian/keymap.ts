export class Scope {
  readonly handlers: Array<{
    readonly callback: (event: KeyboardEvent) => unknown;
    readonly key: string | null;
  }> = [];

  register(
    _modifiers: readonly string[] | null,
    key: string | null,
    callback: (event: KeyboardEvent) => unknown,
  ): object {
    this.handlers.push({ callback, key });
    return {};
  }

  unregister(_handler: object): void {}
}

export class Keymap {
  readonly scopes: Scope[] = [];

  pushScope(scope: Scope): void {
    this.scopes.push(scope);
  }

  popScope(scope: Scope): void {
    const index = this.scopes.lastIndexOf(scope);
    if (index >= 0) this.scopes.splice(index, 1);
  }
}
