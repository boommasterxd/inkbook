export type InkbookColorScheme = "dark" | "light";

export interface ColorSchemeSource {
  getColorScheme(): InkbookColorScheme;
}

export type ColorSchemeListener = (scheme: InkbookColorScheme) => void;

export class ColorSchemeBroadcaster {
  readonly #listeners = new Set<ColorSchemeListener>();
  readonly #source: ColorSchemeSource;

  constructor(source: ColorSchemeSource) {
    this.#source = source;
  }

  subscribe(listener: ColorSchemeListener): () => void {
    this.#listeners.add(listener);
    listener(this.#source.getColorScheme());
    return () => {
      this.#listeners.delete(listener);
    };
  }

  refresh(): void {
    const scheme = this.#source.getColorScheme();
    for (const listener of this.#listeners) {
      listener(scheme);
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}

export function applyColorScheme(root: HTMLElement, scheme: InkbookColorScheme): void {
  root.style.colorScheme = scheme;
  root.dataset.inkbookScheme = scheme;
}
