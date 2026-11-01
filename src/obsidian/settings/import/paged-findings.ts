import { setIcon } from "obsidian";

const PAGE_SIZE = 25;
type MutateLayout = (update: () => void) => void;

/** Bounds published findings while preserving access to every result. */
export function renderPagedItems(
  container: HTMLElement,
  options: {
    readonly label: string;
    readonly count: number;
    readonly entry: (item: HTMLElement, index: number) => void;
    readonly mutate?: MutateLayout;
    readonly initialItem?: number;
    readonly releasePage?: () => void;
  },
): void {
  const { label, count, entry } = options;
  if (count === 0) return;
  const list = container.createEl("ul", { cls: "inkbook-import-list" });
  list.setAttribute("aria-label", label);
  let page = Math.min(
    Math.floor(Math.max(0, options.initialItem ?? 0) / PAGE_SIZE),
    Math.ceil(count / PAGE_SIZE) - 1,
  );
  const publish = (): void => {
    options.releasePage?.();
    list.replaceChildren();
    const start = page * PAGE_SIZE;
    const end = Math.min(count, start + PAGE_SIZE);
    for (let index = start; index < end; index += 1) {
      entry(list.createEl("li", { cls: "inkbook-import-list-item" }), index);
    }
  };
  publish();
  if (count <= PAGE_SIZE) return;
  const navigation = container.createDiv({ cls: "inkbook-import-pagination" });
  const previous = pageButton(navigation, "Previous", label, "chevron-left");
  const range = navigation.createSpan({ cls: "inkbook-import-page-range" });
  range.setAttribute("aria-live", "polite");
  const next = pageButton(navigation, "Next", label, "chevron-right");
  const updateNavigation = (): void => {
    const start = page * PAGE_SIZE;
    const end = Math.min(count, start + PAGE_SIZE);
    range.textContent = `${start + 1}–${end} of ${count}`;
    previous.disabled = page === 0;
    next.disabled = end === count;
  };
  const turn = (direction: number, target: HTMLButtonElement): void => {
    page += direction;
    const update = (): void => {
      publish();
      updateNavigation();
    };
    if (options.mutate === undefined) update();
    else options.mutate(update);
    (target.disabled ? (direction > 0 ? previous : next) : target).focus();
  };
  previous.addEventListener("click", () => turn(-1, previous));
  next.addEventListener("click", () => turn(1, next));
  updateNavigation();
}

function pageButton(
  container: HTMLElement,
  direction: string,
  label: string,
  icon: string,
): HTMLButtonElement {
  const button = container.createEl("button", { cls: "inkbook-import-page-button" });
  button.type = "button";
  button.setAttribute("aria-label", `${direction} page: ${label.toLowerCase()}`);
  setIcon(button, icon);
  return button;
}
