import {
  loadDeviceSettings,
  loadSettings,
  type ColorV1,
  type InkbookDeviceSettingsV1,
  type InkbookSettingsV4,
} from "../../domain/settings";
import { InkbookSettingsStore } from "./storage";

type VaultControlKey =
  | "startupTool"
  | "refreshRatePreference"
  | "filePlacement.mode"
  | "filePlacement.folder"
  | `pageDefaults.${"backgroundType" | "activeBufferLines" | "lockedBufferLines"}`
  | `pageDefaults.backgroundSpacing.${"lines" | "dots" | "squares"}`
  | `toolDefaults.select.${"area" | "inclusion"}`
  | `toolDefaults.pen.${"color" | "width" | "opacity" | "pressureEnabled"}`
  | `toolDefaults.${"highlighter" | "straightHighlighter"}.${"color" | "width" | "opacity"}`
  | "toolDefaults.eraser.radius"
  | `toolDefaults.shapes.${keyof InkbookSettingsV4["toolDefaults"]["shapes"]}.${
      | "outlineColor"
      | "outlineWidth"
      | "outlineStyle"
      | "outlineOpacity"
      | "fillColor"
      | "fillOpacity"}`
  | `toolDefaults.arrow.${"startNode" | "endNode"}`
  | "toolDefaults.coordinateSystem.dimension"
  | "toolDefaults.table.columns";

type DeviceControlKey = `device.${Exclude<keyof InkbookDeviceSettingsV1, "version">}`;
export type SettingsControlKey = VaultControlKey | DeviceControlKey;

const COLOR_VALUES = new Map<string, ColorV1 | null>([
  ["none", null],
  ["theme-text", { type: "theme-text" }],
  ...[
    "#EF4444FF",
    "#F97316FF",
    "#EAB308FF",
    "#22C55EFF",
    "#06B6D4FF",
    "#3B82F6FF",
    "#8B5CF6FF",
    "#EC4899FF",
    "#6B7280FF",
  ].map((value) => [value, { type: "rgba", value } as ColorV1] as const),
]);

const NUMERIC_KEY_SUFFIXES = [
  ".width",
  ".outlineWidth",
  ".radius",
  ".columns",
  ".activeBufferLines",
  ".lockedBufferLines",
  ".lines",
  ".dots",
  ".squares",
];

function getNested(root: object, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => {
    if (typeof value !== "object" || value === null) return undefined;
    return (value as Record<string, unknown>)[segment];
  }, root);
}

function setNested(root: object, path: string, value: unknown): void {
  const segments = path.split(".");
  const leaf = segments.pop();
  let target = root as Record<string, unknown>;
  for (const segment of segments) target = target[segment] as Record<string, unknown>;
  if (leaf !== undefined) target[leaf] = value;
}

function controlValue(value: unknown): unknown {
  if (value === null) return "none";
  if (typeof value === "object" && value !== null && "type" in value) {
    const color = value as ColorV1;
    return color.type === "theme-text" ? "theme-text" : color.value;
  }
  return value;
}

function domainValue(key: SettingsControlKey, value: unknown): unknown {
  if (key === "refreshRatePreference") return value === "auto" ? value : Number(value);
  if (key.endsWith("Color") || key.endsWith(".color")) return COLOR_VALUES.get(String(value));
  if (NUMERIC_KEY_SUFFIXES.some((suffix) => key.endsWith(suffix))) return Number(value);
  return value;
}

export class SettingsControlValues {
  public constructor(private readonly store: InkbookSettingsStore) {}

  public get(key: SettingsControlKey): unknown {
    const path = key.startsWith("device.") ? key.slice(7) : key;
    const root = key.startsWith("device.")
      ? this.store.getDeviceSettings()
      : this.store.getVaultSettings();
    if (
      key === "filePlacement.folder" &&
      !("folder" in this.store.getVaultSettings().filePlacement)
    ) {
      return "";
    }
    return controlValue(getNested(root, path));
  }

  public async set(key: SettingsControlKey, value: unknown): Promise<void> {
    if (key.startsWith("device.")) {
      const candidate = structuredClone(this.store.getDeviceSettings());
      setNested(candidate, key.slice(7), domainValue(key, value));
      const loaded = loadDeviceSettings(candidate);
      if (loaded.diagnostics.length > 0) throw new Error("Invalid setting value");
      this.store.replaceDeviceSettings(loaded.value);
      return;
    }

    await this.store.updateVaultSettings((candidate) => {
      if (key === "filePlacement.mode") {
        candidate.filePlacement =
          value === "custom-vault-folder"
            ? { mode: "custom-vault-folder", folder: "Inkbook" }
            : { mode: value as "obsidian-attachment-folder" | "note-folder" };
      } else if (key === "filePlacement.folder") {
        candidate.filePlacement = { mode: "custom-vault-folder", folder: String(value) };
      } else {
        setNested(candidate, key, domainValue(key, value));
      }
      const loaded = loadSettings(candidate);
      if (loaded.diagnostics.length > 0) throw new Error("Invalid setting value");
      return loaded.value;
    });
  }
}
