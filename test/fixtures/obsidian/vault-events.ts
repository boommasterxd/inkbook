import type { TAbstractFile } from "obsidian";

type VaultEventCallback = (file: TAbstractFile, oldPath?: string) => void;

export function createVaultEvents() {
  const listeners = new Map<string, Set<VaultEventCallback>>();
  return {
    emit(event: string, file: TAbstractFile, oldPath?: string): void {
      for (const callback of listeners.get(event) ?? []) callback(file, oldPath);
    },
    listenerCount(): number {
      return [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0);
    },
    on(event: string, callback: VaultEventCallback) {
      const callbacks = listeners.get(event) ?? new Set<VaultEventCallback>();
      listeners.set(event, callbacks);
      callbacks.add(callback);
      return { detach: () => callbacks.delete(callback) };
    },
  };
}
