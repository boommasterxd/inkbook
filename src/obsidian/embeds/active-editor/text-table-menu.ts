import {
  createEnglishLocalization,
  type Localization,
  type MessageKey,
} from "../../../domain/localization";
import type { TextTableUiAction, TextTableUiPort } from "../../text/editor/text-table-controls";
import { LocalizedActionMenu } from "../../menus/localized-action-menu";
import type { MenuFactoryPort, MenuPosition } from "../../menus/menu-ports";

interface TableMenuOptions {
  readonly factory: MenuFactoryPort;
  readonly owner: HTMLElement;
  readonly localization?: Localization | undefined;
}

type TableMenuRequest = Parameters<TextTableUiPort["openMenu"]>[0];

/** Project the isolated text frame's coordinates into its owning presentation. */
function anchorPosition(anchor: HTMLElement, owner: HTMLElement): MenuPosition {
  const rect = anchor.getBoundingClientRect();
  let x = rect.left;
  let y = rect.bottom;
  let width = rect.width;
  let current = anchor.ownerDocument.defaultView;
  const target = owner.ownerDocument.defaultView;
  while (current && current !== target) {
    const frame = current.frameElement;
    if (!frame) break;
    const bounds = frame.getBoundingClientRect();
    const element = frame as HTMLElement;
    const scaleX = element.offsetWidth > 0 ? bounds.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight > 0 ? bounds.height / element.offsetHeight : 1;
    x = bounds.left + (x + element.clientLeft) * scaleX;
    y = bounds.top + (y + element.clientTop) * scaleY;
    width *= scaleX;
    current = frame.ownerDocument.defaultView;
  }
  return { x, y, width };
}

function populateMenu(actions: LocalizedActionMenu, request: TableMenuRequest): void {
  const add = (key: MessageKey, icon: string, action: TextTableUiAction, checked?: boolean) =>
    actions.addItem(key, (item) => {
      item.setIcon(icon).onClick(() => {
        request.onPreview?.(undefined);
        request.onAction(action);
      });
      item.onHighlight?.((active) => request.onPreview?.(active ? action : undefined));
      if (checked !== undefined) item.setChecked?.(checked);
      if (action.kind === "delete-row" || action.kind === "delete-column") item.setWarning(true);
    });
  add("editor.table.row-above", "arrow-up", {
    kind: "insert-row",
    row: request.row,
    placement: "before",
  });
  add("editor.table.row-below", "arrow-down", {
    kind: "insert-row",
    row: request.row,
    placement: "after",
  });
  add("editor.table.column-left", "arrow-left", { kind: "insert-column", column: request.column });
  add("editor.table.column-right", "arrow-right", {
    kind: "insert-column",
    column: request.column + 1,
  });
  actions.addSeparator();
  add("editor.table.delete-row", "trash-2", { kind: "delete-row", row: request.row });
  add("editor.table.delete-column", "trash-2", { kind: "delete-column", column: request.column });
  actions.addSeparator();
  for (const alignment of ["left", "center", "right"] as const) {
    add(
      `editor.table.align-${alignment}`,
      `align-${alignment}`,
      {
        kind: "align-column",
        column: request.column,
        alignment,
      },
      request.alignment === undefined ? undefined : request.alignment === alignment,
    );
  }
  actions.addSeparator();
  add("editor.table.source", "code", { kind: "source" });
}

/** Existing owned context menus supply desktop placement and the phone sheet. */
export function createTextTableUi(options: TableMenuOptions): TextTableUiPort {
  const localization = options.localization ?? createEnglishLocalization();
  return {
    get labels() {
      return {
        addRow: localization.t("editor.table.add-row"),
        addColumn: localization.t("editor.table.add-column"),
        menu: localization.t("editor.table.menu"),
        source: localization.t("editor.table.source"),
        preview: localization.t("editor.table.preview"),
        cell: localization.t("editor.action.edit-table-cell"),
      };
    },
    openMenu(request) {
      if (request.signal.aborted) return;
      const menu = options.factory.create("context");
      menu.setParentElement?.(options.owner);
      const abort = () => menu.close("immediate");
      request.signal.addEventListener("abort", abort, { once: true });
      menu.onHide(() => {
        request.signal.removeEventListener("abort", abort);
        request.onClose();
      });
      menu.addItem((item) => {
        item.setIsLabel(true);
        const update = () =>
          item.setTitle(
            localization.t("editor.table.target", {
              row: request.row + 1,
              column: request.column + 1,
            }),
          );
        update();
        menu.onHide(localization.subscribe(update));
      });
      populateMenu(
        new LocalizedActionMenu(menu, options.owner.ownerDocument, localization),
        request,
      );
      menu.showAtPosition(
        anchorPosition(request.anchor, options.owner),
        options.owner.ownerDocument,
      );
    },
  };
}
