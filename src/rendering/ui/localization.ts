import { createContext, useContext, useState, useSyncExternalStore } from "react";
import { createEnglishLocalization, type Localization } from "../../domain/localization";

export const editorLocalizationContext = createContext<Localization | undefined>(undefined);

/** Locale updates re-render retained chrome without resetting its interaction state. */
export function useEditorLocalization(explicit?: Localization): Localization {
  const inherited = useContext(editorLocalizationContext);
  const [fallback] = useState(createEnglishLocalization);
  const localization = explicit ?? inherited ?? fallback;
  useSyncExternalStore(
    (listener) => localization.subscribe(listener),
    () => localization.language,
  );
  return localization;
}
