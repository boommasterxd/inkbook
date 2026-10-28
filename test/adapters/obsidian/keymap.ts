import type { Scope as ObsidianScope } from "obsidian";

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

  handleKey(event: KeyboardEvent): unknown {
    for (const handler of this.handlers) {
      if (handler.key !== null && handler.key !== event.key) continue;
      const result = handler.callback(event);
      if (result !== undefined || handler.key !== null) return result;
    }
    return undefined;
  }
}

export class Keymap {
  readonly scopes: Scope[] = [];

  pushScope(scope: Scope | ObsidianScope): void {
    this.scopes.push(scope as Scope);
  }

  popScope(scope: Scope | ObsidianScope): void {
    const index = this.scopes.lastIndexOf(scope as Scope);
    if (index >= 0) this.scopes.splice(index, 1);
  }

  /** Install before plugin listeners, matching the native host's Window capture order. */
  installCapture(ownerWindow: Window): () => void {
    const listener = (event: KeyboardEvent): void => {
      if (this.scopes[this.scopes.length - 1]?.handleKey(event) === false) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    ownerWindow.addEventListener("keydown", listener, { capture: true });
    return () => ownerWindow.removeEventListener("keydown", listener, { capture: true });
  }
}
