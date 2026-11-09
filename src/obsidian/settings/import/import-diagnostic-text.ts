import type { Localization } from "../../../domain/localization";
import type { ImportDiagnostic } from "../../import/diagnostics";

export function importDiagnosticText(
  localization: Localization,
  message: string,
  diagnostic?: ImportDiagnostic | null,
): string {
  if (diagnostic === undefined || diagnostic === null)
    return localization.t("import.legacyDiagnostic", { message });
  const text = localization.t(`import.diagnostic.${diagnostic.code}`);
  return diagnostic.path === undefined
    ? text
    : localization.t("import.diagnosticPath", { message: text, path: diagnostic.path });
}
