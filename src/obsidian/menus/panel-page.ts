/** Content lifecycle shared by adaptive panels and their phone subpages. */
export interface AdaptivePanelContentLifecycle {
  prepareLayoutChange(): void;
  requestLayout(): void;
}

export interface PhoneSheetPage {
  readonly kind: "background" | "dialog";
  readonly label: string;
  readonly createContent: (lifecycle: AdaptivePanelContentLifecycle) => DocumentFragment;
  readonly dispose?: () => void;
}

/** Navigation within an existing phone sheet, without replacing its host. */
export interface PhoneSheetNavigation {
  readonly ownerDocument: Document;
  push(page: PhoneSheetPage): void;
  back(): boolean;
  close(mode?: "animated" | "immediate"): void;
}
