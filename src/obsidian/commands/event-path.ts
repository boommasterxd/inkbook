export function eventPathHasClass(event: Event, className: string): boolean {
  return event.composedPath().some((candidate) => {
    if (typeof candidate !== "object" || candidate === null || !("classList" in candidate)) {
      return false;
    }
    const classList = candidate.classList as { contains?: (token: string) => boolean };
    return classList.contains?.call(classList, className) === true;
  });
}
