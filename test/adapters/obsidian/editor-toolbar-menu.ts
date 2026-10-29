import { workSchedulerFromFrames } from "../../fixtures/obsidian/work-scheduler";
import { vi } from "vitest";

import type {
  EditorToolbarMenuOptions,
  EditorToolbarMenuState,
  MenuItemPort,
  MenuPort,
  MenuPosition,
} from "../../../src/obsidian/menus";
import { createHtmlElement } from "./dom";

export interface RecordedMenuItem {
  checked?: boolean | null;
  click?: () => void;
  disabled?: boolean;
  fragment?: DocumentFragment;
  icon?: string;
  label?: boolean;
  title?: string;
  warning?: boolean;
}

export function installNativeMenuMeasurementStyles(): void {
  document.body.setCssProps({
    "--font-ui-medium": "16px",
    "--font-ui-small": "13px",
    "--icon-s": "16px",
    "--menu-border-width": "1px",
    "--menu-padding": "6px",
    "--size-4-2": "8px",
  });
  const context = {
    font: "",
    measureText: () => ({ width: context.font.includes("16px") ? 100 : 90 }),
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context);
}

class FakeMenuItem implements MenuItemPort {
  public constructor(private readonly record: RecordedMenuItem) {}

  public setTitle(title: string): this {
    this.record.title = title;
    return this;
  }

  public setTitleFragment(fragment: DocumentFragment): this {
    this.record.fragment = fragment;
    const title = fragment.querySelector(".inkbook-menu-title-content")?.textContent;
    if (title !== null && title !== undefined) this.record.title = title;
    return this;
  }

  public setIcon(icon: string): this {
    this.record.icon = icon;
    return this;
  }

  public setChecked(checked: boolean | null): this {
    this.record.checked = checked;
    return this;
  }

  public setDisabled(disabled: boolean): this {
    this.record.disabled = disabled;
    return this;
  }

  public setWarning(warning: boolean): this {
    this.record.warning = warning;
    return this;
  }

  public setIsLabel(label: boolean): this {
    this.record.label = label;
    return this;
  }

  public onClick(callback: (event: unknown) => void): this {
    this.record.click = () => callback(undefined);
    return this;
  }
}

export class FakeEditorToolbarMenu implements MenuPort {
  public readonly entries: Array<RecordedMenuItem | "separator"> = [];
  public readonly positions: MenuPosition[] = [];
  public parent: HTMLElement | undefined;
  private onHideCallback = (): void => undefined;

  public addItem(configure: (item: MenuItemPort) => void): this {
    const record: RecordedMenuItem = {};
    configure(new FakeMenuItem(record));
    this.entries.push(record);
    return this;
  }

  public addSeparator(): this {
    this.entries.push("separator");
    return this;
  }

  public setParentElement(element: HTMLElement): this {
    this.parent = element;
    return this;
  }

  public showAtPosition(position: MenuPosition): this {
    this.positions.push(position);
    return this;
  }

  public onHide(callback: () => void): void {
    this.onHideCallback = callback;
  }

  public close(): void {
    this.onHideCallback();
  }

  public hide(): void {
    this.onHideCallback();
  }
}

export function createEditorToolbarMenuOptions(
  overrides: Partial<EditorToolbarMenuState> = {},
): EditorToolbarMenuOptions {
  const state: EditorToolbarMenuState = {
    background: { spacing: "m", type: "squares" },
    overflow: {
      arrange: {
        "bring-forward": true,
        "bring-to-front": false,
        "send-backward": true,
        "send-to-back": false,
      },
      canEraseAll: true,
      hasSelection: true,
    },
    selectedShape: "rectangle",
    shapeIcon: { arrowEnd: "arrow", arrowStart: "none", coordinateDimension: "2d" },
    styleControls: [],
    ...overrides,
  };
  return {
    anchor: createHtmlElement("button"),
    workScheduler: workSchedulerFromFrames(window),
    canvasInputSurface: createHtmlElement("div"),
    factory: {
      create: () => new FakeEditorToolbarMenu(),
      forEvent: () => new FakeEditorToolbarMenu(),
    },
    getState: () => state,
    handlers: {
      onBackgroundSpacingChange: vi.fn(),
      onBackgroundSpacingPreview: vi.fn(),
      onBackgroundTypeChange: vi.fn(),
      onOverflowAction: vi.fn(),
      onOpenSettings: vi.fn(),
      onOpenShortcuts: vi.fn(),
      onOpenTour: vi.fn(),
      onShapeChange: vi.fn(),
      onStyleChange: vi.fn(),
    },
    initialMenu: "overflow",
    onClosed: vi.fn(),
    ownerDocument: document,
    ownerWindow: window,
    renderIcon: (element, icon) => element.setAttribute("data-icon", icon),
  };
}

export function menuAction(menu: FakeEditorToolbarMenu, title: string): RecordedMenuItem {
  const entry = menu.entries.find(
    (candidate): candidate is RecordedMenuItem =>
      candidate !== "separator" && candidate.title === title,
  );
  if (entry === undefined) throw new Error(`Expected ${title}`);
  return entry;
}

export function menuTitles(menu: FakeEditorToolbarMenu): string[] {
  return menu.entries.flatMap((entry) =>
    entry === "separator" || entry.title === undefined ? [] : [entry.title],
  );
}
