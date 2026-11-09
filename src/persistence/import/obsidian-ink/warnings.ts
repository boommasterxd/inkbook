import { importWarnings } from "../../../domain/localization/locales/en/import-warnings";

type WarningKey = keyof typeof importWarnings;
export type ObsidianInkWarningCode = WarningKey extends `import.warning.${infer Code}`
  ? Code
  : never;

export function isObsidianInkWarningCode(value: unknown): value is ObsidianInkWarningCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(importWarnings, `import.warning.${value}`)
  );
}

export function englishImportWarning(code: ObsidianInkWarningCode): string {
  return importWarnings[`import.warning.${code}`];
}
