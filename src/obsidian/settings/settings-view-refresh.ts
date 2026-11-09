import {
  browserScrollMetrics,
  createBrowserScrollDocumentPort,
  type BrowserScrollElement,
} from "../scrolling/scroll-ports";
import { resolveScrollOwner } from "../scrolling/scroll-owner";

const ROW_SELECTOR = "[data-inkbook-setting-identity]";
const CONTROL_SELECTOR = "button, input, select, [tabindex]";

interface SettingsAnchor {
  readonly identity: string | undefined;
  readonly top: number;
}

/** Retains presentation state through a synchronous settings definition rebuild. */
export function refreshSettingsView(container: HTMLElement, render: () => void): void {
  if (!container.isConnected) {
    render();
    return;
  }
  const document = container.ownerDocument;
  const port = createBrowserScrollDocumentPort(document);
  const owner = ["auto", "scroll"].includes(port.getOverflowY(container))
    ? container
    : resolveScrollOwner(container, port, browserScrollMetrics);
  const scrollTop = owner?.scrollTop ?? container.scrollTop;
  const focused = document.activeElement;
  const row = container.contains(focused) ? focused?.closest<HTMLElement>(ROW_SELECTOR) : null;
  const identity = row?.dataset.inkbookSettingIdentity;
  const controlIndex =
    row === null || row === undefined || focused === null
      ? -1
      : [...row.querySelectorAll(CONTROL_SELECTOR)].indexOf(focused);
  const anchor = visibleAnchor(container, owner);
  render();
  const rows = [...container.querySelectorAll<HTMLElement>(ROW_SELECTOR)];
  if (identity !== undefined) {
    const replacement = rows.find((element) => element.dataset.inkbookSettingIdentity === identity);
    const target =
      focused === row
        ? replacement
        : [...(replacement?.querySelectorAll<HTMLElement>(CONTROL_SELECTOR) ?? [])].find(
            (element) =>
              element.tagName === focused?.tagName &&
              (element.getAttribute("aria-label") === focused.getAttribute("aria-label") ||
                replacement?.querySelectorAll(CONTROL_SELECTOR)[controlIndex] === element),
          );
    target?.focus({ preventScroll: true });
  }
  const replacementAnchor =
    anchor === undefined
      ? undefined
      : rows.find((element) => element.dataset.inkbookSettingIdentity === anchor.identity);
  const targetOwner = owner ?? container;
  targetOwner.scrollTop = scrollTop;
  if (replacementAnchor !== undefined && anchor !== undefined) {
    targetOwner.scrollTop += replacementAnchor.getBoundingClientRect().top - anchor.top;
  }
}

function visibleAnchor(
  container: HTMLElement,
  owner: BrowserScrollElement | null,
): SettingsAnchor | undefined {
  if (owner === null) return undefined;
  const viewport = owner.getBoundingClientRect();
  if (viewport.height === 0) return undefined;
  let overlapping: SettingsAnchor | undefined;
  for (const row of container.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    const bounds = row.getBoundingClientRect();
    if (bounds.height > 0 && bounds.bottom > viewport.top && bounds.top < viewport.bottom) {
      const anchor = { identity: row.dataset.inkbookSettingIdentity, top: bounds.top };
      if (bounds.top >= viewport.top) return anchor;
      overlapping = anchor;
    }
  }
  return overlapping;
}
