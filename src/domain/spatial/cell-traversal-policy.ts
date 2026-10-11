/** Choose coordinate lookups only when no more numerous than occupied axis entries. */
export function shouldVisitAxisRange(minimum: number, maximum: number, occupied: number): boolean {
  return maximum - minimum + 1 <= occupied;
}
