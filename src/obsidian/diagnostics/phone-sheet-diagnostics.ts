import { Notice, Platform, TFile, type TAbstractFile, type Plugin } from "obsidian";

import { installPhoneSheetDiagnostics } from "../menus/phone-sheet-diagnostics";

const CONFIG_PATH = "Inkbook diagnostics/swipe-config.json";
const STORAGE_KEY = "inkbook:phone-sheet-diagnostics";
const MAXIMUM_LIFETIME = 7 * 24 * 60 * 60 * 1000;
type Report = Parameters<Parameters<typeof installPhoneSheetDiagnostics>[1]["complete"]>[0];
interface Configuration {
  readonly id: string;
  readonly expiresAt: number;
  readonly maxReports: number;
}

function parseConfiguration(value: unknown): Configuration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const data = value as Record<string, unknown>;
  if (
    data["version"] !== 1 ||
    typeof data["id"] !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(data["id"]) ||
    typeof data["expiresAt"] !== "number" ||
    !Number.isFinite(data["expiresAt"]) ||
    data["expiresAt"] <= Date.now() ||
    data["expiresAt"] > Date.now() + MAXIMUM_LIFETIME ||
    typeof data["maxReports"] !== "number" ||
    !Number.isInteger(data["maxReports"])
  )
    return undefined;
  return {
    id: data["id"],
    expiresAt: data["expiresAt"],
    maxReports: Math.max(1, Math.min(3, data["maxReports"])),
  };
}

class PhoneSheetDiagnosticRegistration {
  readonly #plugin: Plugin;
  #disposed = false;
  #loading = false;
  #reload = false;
  #stop: (() => void) | undefined;
  #expiry: number | undefined;
  readonly #window: Window;
  #configuration: Configuration | undefined;
  #writes = Promise.resolve();

  constructor(plugin: Plugin) {
    this.#plugin = plugin;
    this.#window = plugin.app.workspace.containerEl.ownerDocument.defaultView!;
    plugin.register(() => {
      this.#disposed = true;
      this.#stopRecording();
    });
    const changed = (file: TAbstractFile): void => {
      if (file.path === CONFIG_PATH) void this.#load();
    };
    plugin.registerEvent(plugin.app.vault.on("create", changed));
    plugin.registerEvent(plugin.app.vault.on("modify", changed));
    plugin.registerEvent(plugin.app.vault.on("delete", changed));
    plugin.app.workspace.onLayoutReady(() => {
      void this.#load();
    });
  }

  async #load(): Promise<void> {
    if (this.#disposed) return;
    if (this.#loading) {
      this.#reload = true;
      return;
    }
    this.#loading = true;
    try {
      do {
        this.#reload = false;
        const configuration = await this.#readConfiguration();
        if (!this.#disposed) this.#activate(configuration);
      } while (this.#reload && !this.#disposed);
    } catch {
      this.#stopRecording();
    } finally {
      this.#loading = false;
    }
  }

  async #readConfiguration(): Promise<Configuration | undefined> {
    try {
      const file = this.#plugin.app.vault.getAbstractFileByPath(CONFIG_PATH);
      if (!(file instanceof TFile) || file.stat.size > 1024) return undefined;
      const text = await this.#plugin.app.vault.read(file);
      if (text.length > 1024) return undefined;
      const value: unknown = JSON.parse(text);
      return parseConfiguration(value);
    } catch {
      return undefined;
    }
  }

  #activate(configuration: Configuration | undefined): void {
    if (configuration && JSON.stringify(configuration) === JSON.stringify(this.#configuration))
      return;
    this.#stopRecording();
    if (!configuration) return;
    let count = this.#readCount(configuration.id);
    if (count >= configuration.maxReports) return;
    this.#configuration = configuration;
    this.#stop = installPhoneSheetDiagnostics(
      this.#plugin.app.workspace.containerEl.ownerDocument,
      {
        claim: () => {
          if (
            this.#disposed ||
            this.#configuration !== configuration ||
            Date.now() >= configuration.expiresAt ||
            count >= configuration.maxReports
          )
            return false;
          try {
            this.#plugin.app.saveLocalStorage(STORAGE_KEY, {
              id: configuration.id,
              count: count + 1,
            });
            count += 1;
            return true;
          } catch {
            return false;
          }
        },
        complete: (report) => {
          if (this.#configuration !== configuration) return;
          this.#enqueue(configuration, count, report);
          if (count >= configuration.maxReports) this.#stopRecording();
        },
      },
    );
    this.#expiry = this.#window.setTimeout(() => {
      this.#stopRecording();
    }, configuration.expiresAt - Date.now());
  }

  #readCount(id: string): number {
    try {
      const value: unknown = this.#plugin.app.loadLocalStorage(STORAGE_KEY);
      if (typeof value !== "object" || value === null) return 0;
      const stored = value as Record<string, unknown>;
      if (stored["id"] !== id) return 0;
      const count = stored["count"];
      return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : 3;
    } catch {
      return 3;
    }
  }

  #enqueue(configuration: Configuration, count: number, report: Report): void {
    if (this.#disposed) return;
    const payload = JSON.stringify({
      version: 1,
      configId: configuration.id,
      timestamp: new Date().toISOString(),
      pluginVersion: this.#plugin.manifest.version,
      report,
    });
    this.#writes = this.#writes
      .then(async () => {
        if (this.#disposed) return;
        const vault = this.#plugin.app.vault;
        const path = `Inkbook diagnostics/swipe-trace-${String(count)}.json`;
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await vault.modify(file, payload);
        else await vault.create(path, payload);
      })
      .catch(() => {
        if (!this.#disposed)
          new Notice(
            "Inkbook could not save the swipe diagnostic. Check that the diagnostics folder is writable.",
          );
      });
  }

  #stopRecording(): void {
    this.#stop?.();
    this.#stop = undefined;
    this.#configuration = undefined;
    if (this.#expiry !== undefined) this.#window.clearTimeout(this.#expiry);
    this.#expiry = undefined;
  }
}

export function registerPhoneSheetDiagnostics(plugin: Plugin): void {
  if (Platform.isPhone) new PhoneSheetDiagnosticRegistration(plugin);
}
