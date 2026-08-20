import { Plugin } from "obsidian";

import { PluginRuntime } from "./adapters/obsidian/plugin-runtime";

export default class InkbookPlugin extends Plugin {
  #runtime: PluginRuntime | undefined;

  public override onload(): Promise<void> {
    if (this.#runtime !== undefined) return Promise.resolve();
    const runtime = new PluginRuntime(this);
    this.#runtime = runtime;
    try {
      runtime.register();
    } catch (error: unknown) {
      runtime.dispose();
      this.#runtime = undefined;
      throw error;
    }
    return Promise.resolve();
  }

  public override onunload(): void {
    this.#runtime?.dispose();
    this.#runtime = undefined;
  }
}
