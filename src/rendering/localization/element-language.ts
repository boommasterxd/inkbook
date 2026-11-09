import { createEnglishLocalization, type Localization } from "../../domain/localization";

/** Marks owned UI parts without changing the host document's language. */
export function bindElementLanguage(
  element: HTMLElement,
  localization: Localization = createEnglishLocalization(),
): () => void {
  const previous = element.getAttribute("lang");
  const update = () => {
    element.setAttribute("lang", localization.language);
  };
  update();
  const unsubscribe = localization.subscribe(update);
  return () => {
    unsubscribe();
    if (previous === null) element.removeAttribute("lang");
    else element.setAttribute("lang", previous);
  };
}
