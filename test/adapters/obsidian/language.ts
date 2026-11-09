let hostLanguage = "en";

export function getLanguage(): string {
  return hostLanguage;
}

export function configureTestHostLanguage(language = "en"): void {
  hostLanguage = language;
}
