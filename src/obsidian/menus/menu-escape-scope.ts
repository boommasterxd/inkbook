import { Scope, type Keymap } from "obsidian";

/** Owns the Escape scope only when a native phone host does not provide one. */
export function installMenuEscapeScope(
  keymap: Pick<Keymap, "popScope" | "pushScope"> | undefined,
  close: () => void,
): () => void {
  const scope = new Scope();
  scope.register([], "Escape", () => {
    close();
    return false;
  });
  keymap?.pushScope(scope);
  return () => keymap?.popScope(scope);
}
