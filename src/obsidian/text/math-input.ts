import type { TextMathStyle } from "../../rendering/text/text-layout-types";

export const MAX_FORMULA_LENGTH = 8192;

export function assertTextMathInput(
  latex: string,
  fontSize: number,
  availableWidth?: number,
): void {
  if (
    latex.length > MAX_FORMULA_LENGTH ||
    !Number.isFinite(fontSize) ||
    fontSize <= 0 ||
    fontSize > 4096
  )
    throw new Error("Math expression exceeds the supported limits.");
  if (availableWidth !== undefined && (!Number.isFinite(availableWidth) || availableWidth < 0))
    throw new Error("Invalid math container width.");
}

export function textMathSource(latex: string, options?: TextMathStyle): string {
  // A newline keeps a final TeX comment from consuming the closing group.
  return options?.bold ? `\\boldsymbol{${latex}\n}` : latex;
}
