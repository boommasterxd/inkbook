import type { InkbookModal } from "../../dialogs/inkbook-modal";
import { menuDomWindow } from "../../menus/menu-dom";

export function mountImportDialogLayout(
  { containerEl, modalEl, contentEl }: Pick<InkbookModal, "containerEl" | "modalEl" | "contentEl">,
  signal: AbortSignal,
): MediaQueryList {
  containerEl.classList.add("inkbook-import-container");
  modalEl.classList.remove("inkbook-action-dialog");
  modalEl.classList.add("inkbook-settings-modal", "inkbook-import-dialog");
  contentEl.classList.add("inkbook-import-content");

  const compact = menuDomWindow(modalEl.ownerDocument, "import dialog").matchMedia(
    "(width <= 480px)",
  );
  const sync = (): void => {
    modalEl.classList.toggle("inkbook-import-dialog-compact", compact.matches);
  };
  sync();
  compact.addEventListener("change", sync);
  signal.addEventListener("abort", () => compact.removeEventListener("change", sync), {
    once: true,
  });
  return compact;
}
