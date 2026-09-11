export interface EditorChromeOpenings {
  readonly confirmEraseAll?: ((signal: AbortSignal) => Promise<boolean>) | undefined;
  readonly onOpenSettings: () => void;
  readonly onOpenShortcuts: () => void;
}
