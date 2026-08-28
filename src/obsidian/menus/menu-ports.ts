/**
 * The menu layer depends on these small ports instead of importing Obsidian
 * types into the editor. The host adapter can pass Obsidian's `Menu` and
 * `MenuItem` through these interfaces without leaking host objects into the
 * menu definition or its tests.
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
  close(): void;
}

export interface MenuFactoryPort {
  create(): MenuPort;
  forEvent(event: MouseEvent | PointerEvent): MenuPort;
}

export interface FocusTargetPort {
  readonly isConnected?: boolean;
  readonly ownerDocument?: Document;
  focus(options?: FocusOptions): void;
}
