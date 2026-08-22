import * as CodeMirrorLanguage from "@codemirror/language";
import * as CodeMirrorState from "@codemirror/state";
import * as CodeMirrorView from "@codemirror/view";
import * as Obsidian from "obsidian";
import { Plugin, type App, type PluginManifest } from "obsidian";

import {
  decodeEmbeddedSource,
  isEmbeddedSourceWindow,
  type EmbeddedSourceWindow,
} from "../persistence/worker/runtime/embedded-source";
import { PLUGIN_RUNTIME_GZIP } from "./plugin-runtime-source";

export interface PluginRuntimeModule {
  readonly activateInkbookPlugin: (
    plugin: Plugin,
    isActive: () => boolean,
  ) => Promise<(() => void) | undefined>;
}

const HOST_MODULES_KEY = "__inkbookHostModules";

export interface PluginRuntimeWindow extends EmbeddedSourceWindow {
  readonly URL: {
    createObjectURL(object: Blob): string;
    revokeObjectURL(url: string): void;
  };
  [HOST_MODULES_KEY]?: Readonly<Record<string, object>>;
}

type ModuleImporter = (url: string) => Promise<unknown>;
type SourceDecoder = (encoded: string, ownerWindow: EmbeddedSourceWindow) => Promise<string>;

export interface PluginRuntimeLoaderPort {
  load(ownerWindow: unknown): Promise<PluginRuntimeModule>;
}

export class PluginRuntimeModuleLoader implements PluginRuntimeLoaderPort {
  readonly #decodeSource: SourceDecoder;
  readonly #hostModules: Readonly<Record<string, object>>;
  readonly #importModule: ModuleImporter;
  readonly #modules = new WeakMap<PluginRuntimeWindow, Promise<PluginRuntimeModule>>();

  public constructor(
    importModule: ModuleImporter = importOwnedModule,
    decodeSource: SourceDecoder = decodeEmbeddedSource,
    hostModules: Readonly<Record<string, object>> = pluginRuntimeHostModules(),
  ) {
    this.#importModule = importModule;
    this.#decodeSource = decodeSource;
    this.#hostModules = hostModules;
  }

  public load(ownerWindow: unknown): Promise<PluginRuntimeModule> {
    const browserWindow = requirePluginRuntimeWindow(ownerWindow);
    const existing = this.#modules.get(browserWindow);
    if (existing !== undefined) return existing;
    const pending = this.#loadOwnedModule(browserWindow);
    this.#modules.set(browserWindow, pending);
    void pending.catch(() => {
      if (this.#modules.get(browserWindow) === pending) this.#modules.delete(browserWindow);
    });
    return pending;
  }

  async #loadOwnedModule(ownerWindow: PluginRuntimeWindow): Promise<PluginRuntimeModule> {
    const source = await this.#decodeSource(PLUGIN_RUNTIME_GZIP, ownerWindow);
    const blob = new ownerWindow.Blob([source], { type: "text/javascript" });
    const objectUrl = ownerWindow.URL.createObjectURL(blob);
    if (ownerWindow[HOST_MODULES_KEY] !== undefined) {
      ownerWindow.URL.revokeObjectURL(objectUrl);
      throw new Error("Inkbook plugin runtime loading is already in progress.");
    }
    ownerWindow[HOST_MODULES_KEY] = this.#hostModules;
    try {
      return requirePluginRuntimeModule(await this.#importModule(objectUrl));
    } finally {
      delete ownerWindow[HOST_MODULES_KEY];
      ownerWindow.URL.revokeObjectURL(objectUrl);
    }
  }
}

export function pluginRuntimeHostModules(): Readonly<Record<string, object>> {
  return {
    "@codemirror/language": CodeMirrorLanguage,
    "@codemirror/state": CodeMirrorState,
    "@codemirror/view": CodeMirrorView,
    obsidian: Obsidian,
  };
}

const productionLoader = new PluginRuntimeModuleLoader();

export default class InkbookPluginLoader extends Plugin {
  #activationGeneration = 0;
  #deactivate: (() => void) | undefined;
  readonly #runtimeLoader: PluginRuntimeLoaderPort;

  public constructor(
    app: App,
    manifest: PluginManifest,
    runtimeLoader: PluginRuntimeLoaderPort = productionLoader,
  ) {
    super(app, manifest);
    this.#runtimeLoader = runtimeLoader;
  }

  override async onload(): Promise<void> {
    const generation = ++this.#activationGeneration;
    const ownerWindow = this.app.workspace.containerEl.ownerDocument.defaultView;
    const module = await this.#runtimeLoader.load(ownerWindow);
    if (this.#activationGeneration !== generation) return;
    const deactivate = await module.activateInkbookPlugin(
      this,
      () => this.#activationGeneration === generation,
    );
    if (this.#activationGeneration === generation) this.#deactivate = deactivate;
    else deactivate?.();
  }

  override onunload(): void {
    this.#activationGeneration += 1;
    this.#deactivate?.();
    this.#deactivate = undefined;
  }
}

async function importOwnedModule(url: string): Promise<unknown> {
  return import(sanitizeOwnedModuleUrl(url));
}

function sanitizeOwnedModuleUrl(url: string): string {
  if (!url.startsWith("blob:")) throw new Error("Inkbook received an invalid runtime module URL.");
  return url;
}

function requirePluginRuntimeModule(value: unknown): PluginRuntimeModule {
  if (
    typeof value !== "object" ||
    value === null ||
    !("activateInkbookPlugin" in value) ||
    typeof value.activateInkbookPlugin !== "function"
  ) {
    throw new Error("The embedded inkbook-plugin-bootstrap runtime is invalid.");
  }
  return value as PluginRuntimeModule;
}

function requirePluginRuntimeWindow(value: unknown): PluginRuntimeWindow {
  if (!isEmbeddedSourceWindow(value) || !("URL" in value)) {
    throw new Error("The owning window does not provide embedded runtime APIs.");
  }
  const url: unknown = value.URL;
  if (
    typeof url !== "object" ||
    url === null ||
    !("createObjectURL" in url) ||
    typeof url.createObjectURL !== "function" ||
    !("revokeObjectURL" in url) ||
    typeof url.revokeObjectURL !== "function"
  ) {
    throw new Error("The owning window does not provide object URL APIs.");
  }
  return value as PluginRuntimeWindow;
}
