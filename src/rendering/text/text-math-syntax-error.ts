/** Only a classified TeX grammar failure may become editable, literal source. */
export class TextMathSyntaxError extends Error {
  public constructor(public readonly code: string) {
    super("Invalid mathematical syntax.");
    this.name = "TextMathSyntaxError";
  }
}
