// The two run starts and the previous run length each have at most 0.0005 rounding error.
const RUN_GAP_ROUNDING_TOLERANCE = 0.0015;

/** Collects paintable text from the already validated static content band. */
export class PreviewTextAlternative {
  #field: Element | undefined;
  #baseline: string | null = null;
  #runEnd: number | undefined;
  #runs: string[] = [];
  #skippedRunOnLine = false;
  #hasText = false;
  #content: HTMLElement | undefined;

  public constructor(private readonly document: Document) {}

  public append(parents: readonly Element[], text: string): void {
    const [root, band, field, span] = parents;
    if (
      parents.length !== 4 ||
      root?.localName !== "svg" ||
      band?.localName !== "g" ||
      band.getAttribute("id") !== "inkbook-content" ||
      field?.localName !== "text" ||
      span?.localName !== "tspan"
    )
      return;
    if (field !== this.#field) {
      this.#finishField();
      this.#field = field;
    }
    this.#appendSpan(span, text);
  }

  #appendSpan(span: Element, text: string): void {
    const baseline = span.getAttribute("y");
    if (
      !(Number(span.getAttribute("fill-opacity")) > 0) ||
      span.getAttribute("fill")?.endsWith("00") !== false
    ) {
      this.#skippedRunOnLine ||= baseline === this.#baseline;
      return;
    }
    const x = Number(span.getAttribute("x"));
    const hasGap = this.#runEnd !== undefined && x - this.#runEnd > RUN_GAP_ROUNDING_TOLERANCE;
    const previous = this.#runs[this.#runs.length - 1];
    if (previous !== undefined) {
      if (baseline !== this.#baseline) this.#runs.push("\n");
      else if ((hasGap || this.#skippedRunOnLine) && /\S$/u.test(previous) && /^\S/u.test(text))
        this.#runs.push(" ");
    }
    this.#skippedRunOnLine = false;
    this.#baseline = baseline;
    const width = Number(span.getAttribute("textLength"));
    this.#runEnd = width > 0 ? x + width : undefined;
    this.#runs.push(text);
    this.#hasText ||= /\S/u.test(text);
  }

  public finish(): HTMLElement | undefined {
    this.#finishField();
    return this.#content;
  }

  #finishField(): void {
    if (this.#hasText) {
      if (this.#content === undefined) {
        this.#content = this.document.createElement("div");
        this.#content.className = "inkbook-locked-preview-text";
      }
      const paragraph = this.document.createElement("p");
      paragraph.textContent = this.#runs.join("");
      this.#content.append(paragraph);
    }
    this.#field = undefined;
    this.#baseline = null;
    this.#runEnd = undefined;
    this.#runs = [];
    this.#skippedRunOnLine = false;
    this.#hasText = false;
  }
}
