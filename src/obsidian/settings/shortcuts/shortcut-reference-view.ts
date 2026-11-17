import { createEnglishLocalization, type Translator } from "../../../domain/localization";
import type { ObsidianHotkeyAccess } from "./obsidian-hotkey-conflicts";
import { createSettingsRow } from "../settings-row";
import {
  fixedShortcutReference,
  gestureModifierReference,
  obsidianCommandReference,
  type FixedShortcutReferenceEntry,
} from "./shortcut-catalog";
import { obsidianHotkeyParts, renderReadOnlyShortcutBinding } from "./shortcut-key-display";

export class ShortcutReferenceView {
  readonly #hostHotkeys: ObsidianHotkeyAccess;

  public constructor(
    hostHotkeys: ObsidianHotkeyAccess,
    private readonly t: Translator = createEnglishLocalization().t,
  ) {
    this.#hostHotkeys = hostHotkeys;
  }

  public renderFixed(container: HTMLElement): void {
    this.#renderEntries(
      container,
      fixedShortcutReference(this.t),
      this.t("settings.shortcuts.fixedPrefix"),
    );
  }

  public renderGestures(container: HTMLElement): void {
    this.#renderEntries(
      container,
      gestureModifierReference(this.t),
      this.t("settings.shortcuts.gesturePrefix"),
    );
  }

  public prepareCommands(container: HTMLElement): () => void {
    const commands = obsidianCommandReference(this.t);
    const entries = commands.map((command) => ({
      ...command,
      keyGroups: [],
    }));
    this.#renderEntries(container, entries, this.t("settings.shortcuts.commandPrefix"));
    const displays = [
      ...container.querySelectorAll<HTMLElement>(".inkbook-shortcut-recorder-static"),
    ];
    let previousBindings: string | undefined;
    return () => {
      const bindings = this.#hostHotkeys.readBindings();
      const identity = JSON.stringify(
        commands.map(({ commandId }) => bindings.get(commandId) ?? []),
      );
      if (identity === previousBindings) return;
      previousBindings = identity;
      for (const [index, command] of commands.entries()) {
        const display = displays[index];
        if (display === undefined) continue;
        display.replaceChildren();
        renderReadOnlyShortcutBinding(
          display,
          (bindings.get(command.commandId) ?? []).map(obsidianHotkeyParts),
          this.t,
        );
        labelReadOnlyShortcut(
          display,
          command.label,
          this.t("settings.shortcuts.commandPrefix"),
          this.t,
        );
      }
    };
  }

  #renderEntries(
    container: HTMLElement,
    entries: readonly FixedShortcutReferenceEntry[],
    ariaPrefix: string,
  ): void {
    const list = container.createDiv({ cls: "inkbook-shortcut-reference-list" });
    for (const entry of entries) renderReadOnlyShortcut(list, entry, ariaPrefix, this.t);
  }
}

function renderReadOnlyShortcut(
  container: HTMLElement,
  entry: FixedShortcutReferenceEntry,
  ariaPrefix: string,
  t: Translator,
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
  renderReadOnlyShortcutBinding(display, entry.keyGroups, t);
  display.setAttribute("role", "group");
  labelReadOnlyShortcut(display, entry.label, ariaPrefix, t);
}

function labelReadOnlyShortcut(
  display: HTMLElement,
  label: string,
  ariaPrefix: string,
  t: Translator,
): void {
  display.setAttribute(
    "aria-label",
    t("settings.shortcuts.referenceLabel", {
      prefix: ariaPrefix,
      action: label,
      binding: display.textContent ?? "",
    }),
  );
}
