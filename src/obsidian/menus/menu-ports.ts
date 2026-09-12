/**
 * The menu layer depends on these small ports instead of importing Obsidian
 * types into the editor. The owned menu renderer implements these interfaces
 * without leaking host objects into menu definitions or their tests.
 */

export interface MenuPosition {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly overlap?: boolean;
  readonly left?: boolean;
}

export interface MenuItemPort {
  setTitle(title: string): MenuItemPort;
  setTitleFragment?(title: DocumentFragment): MenuItemPort;
  setIcon(icon: string): MenuItemPort;
  setChecked?(checked: boolean | null): MenuItemPort;
  setDisabled(disabled: boolean): MenuItemPort;
  setWarning(isWarning: boolean): MenuItemPort;
  setIsLabel(isLabel: boolean): MenuItemPort;
  onClick(callback: (event: unknown) => void): MenuItemPort;
}

export interface MenuPort {
  addItem(configure: (item: MenuItemPort) => void): MenuPort;
  addSeparator(): MenuPort;
  setParentElement?(element: HTMLElement): MenuPort;
  showAtPosition(position: MenuPosition, ownerDocument: Document): MenuPort;
  onHide(callback: () => void): void;
  close(mode?: "animated" | "immediate" | "handoff"): void;
}

export interface MenuFactoryPort {
  create(kind?: "context" | "menu"): MenuPort;
  forEvent(event: MouseEvent | PointerEvent): MenuPort;
}

export interface FocusTargetPort {
  readonly isConnected?: boolean;
  readonly ownerDocument?: Document;
  focus(options?: FocusOptions): void;
}
