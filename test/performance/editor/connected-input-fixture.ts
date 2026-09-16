import { connectedLine, rectangle } from "../../unit/domain/store/fixtures";

export function connectedPreviewDependents(target: ReturnType<typeof rectangle>) {
  return Array.from({ length: 512 }, (_, index) => ({
    ...connectedLine(target),
    createdAt: index + 2,
    id: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
  }));
}

export function movingSnapLine() {
  return {
    ...connectedLine(),
    end: { x: 100, y: 0 },
    pivot: { x: 50, y: 0 },
    start: { x: 0, y: 0 },
    startConnection: null,
  };
}
