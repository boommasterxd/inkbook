import type { App } from "./plugin";

/** External core-settings edge; individual tests supply Obsidian's resolved values. */
export class SettingTab {
  public app!: App;

  public getControlValue(_key: string): unknown {
    return undefined;
  }

  public setControlValue(_key: string, _value: unknown): void | Promise<void> {}
}
