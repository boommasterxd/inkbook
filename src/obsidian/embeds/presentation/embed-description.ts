interface EmbedDescription {
  readonly controls: Set<HTMLElement>;
  readonly preview: HTMLElement;
  span?: HTMLElement;
}

const descriptions = new WeakMap<HTMLElement, EmbedDescription>();
let nextDescription = 0;

/** Retains author text outside the preview so the active canvas can describe it too. */
export function updateEmbedDescription(
  root: HTMLElement,
  preview: HTMLElement | undefined,
  description: string | undefined,
): void {
  const record: EmbedDescription | undefined =
    descriptions.get(root) ??
    (preview === undefined ? undefined : { controls: new Set<HTMLElement>(), preview });
  if (record === undefined) return;
  descriptions.set(root, record);
  record.preview.setAttribute(
    "aria-label",
    description ? `Edit handwriting: ${description}` : "Edit handwriting",
  );
  if (description !== undefined && record.span === undefined) {
    record.span = root.createSpan();
    record.span.id = `inkbook-embed-description-${++nextDescription}`;
    record.span.hidden = true;
  }
  if (record.span !== undefined) record.span.textContent = description ?? "";
  for (const control of record.controls) connectDescription(control, record.span);
}

export function bindEmbedDescription(root: HTMLElement, control: HTMLElement): () => void {
  const record = descriptions.get(root);
  if (record === undefined) return () => undefined;
  record.controls.add(control);
  connectDescription(control, record.span);
  return () => {
    record.controls.delete(control);
    if (record.span !== undefined) removeDescription(control, record.span.id);
  };
}

function connectDescription(control: HTMLElement, span: HTMLElement | undefined): void {
  if (span === undefined) return;
  removeDescription(control, span.id);
  if (span.textContent) {
    const previous = control.getAttribute("aria-describedby");
    control.setAttribute("aria-describedby", [previous, span.id].filter(Boolean).join(" "));
  }
}

function removeDescription(control: HTMLElement, id: string): void {
  const ids = (control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((value) => value && value !== id);
  if (ids.length === 0) control.removeAttribute("aria-describedby");
  else control.setAttribute("aria-describedby", ids.join(" "));
}
