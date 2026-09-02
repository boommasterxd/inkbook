import type { ObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";
import { createSettingsRow } from "./settings-row";
import {
  FIXED_SHORTCUT_REFERENCE,
  GESTURE_MODIFIER_REFERENCE,
  OBSIDIAN_COMMAND_REFERENCE,
  type FixedShortcutReferenceEntry,
} from "./shortcut-catalog";
import { obsidianHotkeyParts, renderReadOnlyShortcutBinding } from "./shortcut-key-display";

export class ShortcutReferenceView {
  readonly #hostHotkeys: ObsidianHotkeyAccess;

  public constructor(hostHotkeys: ObsidianHotkeyAccess) {
    this.#hostHotkeys = hostHotkeys;
  }

  public renderFixed(container: HTMLElement): void {
    this.#renderEntries(container, FIXED_SHORTCUT_REFERENCE, "Fixed shortcut");
  }

  public renderGestures(container: HTMLElement): void {
    this.#renderEntries(container, GESTURE_MODIFIER_REFERENCE, "Gesture modifier");
  }

  public renderCommands(container: HTMLElement): void {
    const bindings = this.#hostHotkeys.readBindings();
    const entries = OBSIDIAN_COMMAND_REFERENCE.map((command) => ({
      ...command,
      keyGroups: (bindings.get(command.commandId) ?? []).map(obsidianHotkeyParts),
    }));
    this.#renderEntries(container, entries, "Obsidian shortcut");
  }

  #renderEntries(
    container: HTMLElement,
    entries: readonly FixedShortcutReferenceEntry[],
    ariaPrefix: string,
  ): void {
    const list = container.createDiv({ cls: "inkbook-shortcut-reference-list" });
    for (const entry of entries) renderReadOnlyShortcut(list, entry, ariaPrefix);
  }
}

function renderReadOnlyShortcut(
  container: HTMLElement,
  entry: FixedShortcutReferenceEntry,
  ariaPrefix: string,
): void {
  const { control, row } = createSettingsRow(container, {
    className: "inkbook-shortcut-reference-row",
    description: entry.description,
    name: entry.label,
  });
  row.classList.add("inkbook-shortcut-readonly-row");
  control.classList.add("inkbook-shortcut-controls");
  const display = control.createDiv({
    cls: "inkbook-shortcut-recorder inkbook-shortcut-recorder-static",
  });
  renderReadOnlyShortcutBinding(display, entry.keyGroups);
  display.setAttribute("aria-label", `${ariaPrefix} for ${entry.label}: ${display.textContent}`);
}
