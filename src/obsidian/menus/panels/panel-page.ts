/** Content lifecycle shared by adaptive panels and their phone subpages. */
export interface AdaptivePanelContentLifecycle {
  mutateLayout(update: () => void): void;
  readonly registerLocaleUpdate?: ((update: () => void) => void) | undefined;
}

export interface PhoneSheetPage {
  readonly kind: "background" | "dialog";
  readonly label: string;
  readonly readLabel?: () => string;
  readonly subscribeLabel?: (listener: () => void) => () => void;
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
