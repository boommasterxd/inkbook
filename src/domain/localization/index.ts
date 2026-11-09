import { english, german, type MessageKey } from "./catalogs";

export type { MessageKey } from "./catalogs";
export type Language = "en" | "de";
export type LanguagePreference = "auto" | Language;
export type TranslationParameters = Readonly<Record<string, string | number>>;
export type Translator = (key: MessageKey, parameters?: TranslationParameters) => string;

export function resolveLanguage(preference: LanguagePreference, hostLanguage: string): Language {
  if (preference !== "auto") return preference;
  return hostLanguage.toLowerCase().split(/[-_]/u)[0] === "de" ? "de" : "en";
}

/** Instance-owned UI localization. Persisted documents never depend on its language. */
export class Localization {
  private currentLanguage: Language;
  private hostLanguage: string;
  private readonly listeners = new Set<() => void>();

  public constructor(preference: LanguagePreference = "en", hostLanguage = "en") {
    this.hostLanguage = hostLanguage;
    this.currentLanguage = resolveLanguage(preference, hostLanguage);
  }

  public get language(): Language {
    return this.currentLanguage;
  }

  public readonly t: Translator = (key, parameters = {}) => {
    const template = (this.language === "de" ? german[key] : undefined) ?? english[key];
    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (placeholder, name: string) => {
      const value = parameters[name];
      return value === undefined
        ? placeholder
        : typeof value === "number"
          ? this.number(value)
          : value;
    });
  };

  public setLanguage(preference: LanguagePreference, hostLanguage = this.hostLanguage): void {
    this.hostLanguage = hostLanguage;
    const language = resolveLanguage(preference, hostLanguage);
    if (language === this.currentLanguage) return;
    this.currentLanguage = language;
    for (const listener of [...this.listeners]) listener();
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public number(value: number, options?: Intl.NumberFormatOptions): string {
    return new Intl.NumberFormat(this.language, options).format(value);
  }

  public date(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat(this.language, options).format(value);
  }

  public plural(value: number): Intl.LDMLPluralRule {
    return new Intl.PluralRules(this.language).select(value);
  }
}

export function createEnglishLocalization(): Localization {
  return new Localization();
}
