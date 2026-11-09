import {
  createEnglishLocalization,
  type Localization,
  type Translator,
} from "../../domain/localization";

export interface MenuLocalizationOptions {
  readonly localization?: Localization | undefined;
  readonly t?: Translator | undefined;
  readonly registerLocaleUpdate?: ((update: () => void) => void) | undefined;
}

/** Registers semantic text updates with the owning surface's existing lifecycle. */
export function menuTranslator(options: MenuLocalizationOptions): Translator {
  return options.t ?? options.localization?.t ?? createEnglishLocalization().t;
}

export function updateMenuText(options: MenuLocalizationOptions, update: () => void): void {
  update();
  options.registerLocaleUpdate?.(update);
}
