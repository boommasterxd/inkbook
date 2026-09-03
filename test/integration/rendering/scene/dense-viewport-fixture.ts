import { calculateElementBounds } from "../../../../src/domain/geometry/bounds";
import { buildElementPathParts } from "../../../../src/domain/geometry/element-path";
import type { PageV1, PointV1, StrokeElementV1 } from "../../../../src/domain/schema/public";
import { SvgSceneRenderer } from "../../../../src/rendering/scene";
import { type SceneElementRecord } from "../../../../src/rendering/scene/types";
import {
  FakeDocument,
  FakeNode,
  FakeSceneStore,
  FakeScheduler,
  asElement,
} from "../../../unit/rendering/scene/fakes";

const DENSE_VIEWPORT_ELEMENT_COUNT = 2_500;
const DENSE_VIEWPORT_FIXTURE_VERSION = "dense-viewport-v1";
export const DENSE_VIEWPORT_PROFILES = [
  { elapsedLimitMs: 500, frameLimit: 30, name: "desktop", viewport: [1_200, 800] },
  { elapsedLimitMs: 1_000, frameLimit: 60, name: "mobile", viewport: [390, 700] },
] as const;

const PAGE: PageV1 = {
  activeBufferLines: 3,
  background: { type: "none" },
  innerWidth: 2_000,
  lockedBufferLines: 1,
  margin: 24.3,
};

interface DenseViewportHit {
  readonly expectedId: string;
  readonly point: PointV1;
}

export interface DenseViewportFixture {
  readonly contentIds: readonly string[];
  readonly expectedIds: readonly string[];
  readonly highlightIds: readonly string[];
  readonly hits: readonly DenseViewportHit[];
  readonly idByPath: ReadonlyMap<string, string>;
  readonly records: readonly SceneElementRecord[];
}

export class DenseViewportStore extends FakeSceneStore {
  public queryCount = 0;

  public override query(...parameters: Parameters<FakeSceneStore["query"]>): void {
    this.queryCount += 1;
    super.query(...parameters);
  }
}

export function createDenseViewportFixture(): DenseViewportFixture {
  const records = Array.from({ length: DENSE_VIEWPORT_ELEMENT_COUNT }, (_, index) =>
    createRecord(index),
  );
  const highlightIds = expectedBandIds(0);
  const contentIds = expectedBandIds(1);
  const idByPath = new Map<string, string>();
  for (const record of records) {
    const paths = buildElementPathParts(record.element);
    const path = paths[0]?.d;
    if (paths.length !== 1) throw new Error("Dense viewport elements must render as one path.");
    if (path === undefined || idByPath.has(path)) {
      throw new Error("Dense viewport fixture paths must be unique.");
    }
    idByPath.set(path, record.id);
  }
  return {
    contentIds,
    expectedIds: [...highlightIds, ...contentIds],
    highlightIds,
    hits: Array.from({ length: 100 }, (_, index) => ({
      expectedId: fixtureId(index),
      point: markerCenter(index),
    })),
    idByPath,
    records,
  };
}

export function createDenseViewportHarness(options: {
  readonly fixture: DenseViewportFixture;
  readonly reverseInsertion?: boolean;
  readonly viewport: readonly [number, number];
}): { renderer: SvgSceneRenderer; scheduler: FakeScheduler; store: DenseViewportStore } {
  const document = new FakeDocument();
  const scheduler = new FakeScheduler();
  const store = new DenseViewportStore();
  const records = options.reverseInsertion
    ? [...options.fixture.records].reverse()
    : options.fixture.records;
  for (const record of records) store.records.set(record.id, record);
  const renderer = new SvgSceneRenderer({
    container: asElement(new FakeNode(document, "div")),
    layout: {
      readViewport: () => ({
        height: options.viewport[1],
        left: 0,
        top: 0,
        width: options.viewport[0],
      }),
    },
    page: PAGE,
    scheduler,
    store,
  });
  return { renderer, scheduler, store };
}

function createRecord(index: number): SceneElementRecord {
  const id = fixtureId(index);
  const band = index % 2 === 0 ? "highlight" : "content";
  const center = index < 100 ? markerCenter(index) : backgroundCenter(index);
  const start = { x: center.x - 4, y: center.y };
  const end = { x: center.x + 4 + index / 100_000, y: center.y };
  const width: StrokeElementV1["style"]["width"] = band === "highlight" ? 8 : 2;
  const element = createStroke({ band, center, createdAt: index, end, id, start, width });
  return {
    band,
    bounds: calculateElementBounds(element),
    element,
    geometryVersion: 1,
    id,
    paintVersion: 1,
    rank: Math.floor(index / 4),
  };
}

function createStroke(options: {
  readonly band: "content" | "highlight";
  readonly center: PointV1;
  readonly createdAt: number;
  readonly end: PointV1;
  readonly id: string;
  readonly start: PointV1;
  readonly width: StrokeElementV1["style"]["width"];
}): StrokeElementV1 {
  const { band, center, createdAt, end, id, start, width } = options;
  return {
    createdAt,
    id,
    kind: "stroke",
    pivot: midpoint(start, end),
    points: [start.x, start.y, 0.5, center.x, center.y, 0.5, end.x, end.y, 0.5],
    rotation: 0,
    style: {
      color: { type: "rgba", value: band === "highlight" ? "#FFFF0080" : "#112233FF" },
      opacity: band === "highlight" ? 0.5 : 1,
      pressureEnabled: band === "content",
      smoothing: 0.5,
      width,
    },
    tool: band === "highlight" ? "highlighter" : "pen",
  };
}

function expectedBandIds(parity: 0 | 1): string[] {
  const ids: string[] = [];
  for (let rank = 0; rank < DENSE_VIEWPORT_ELEMENT_COUNT / 4; rank += 1) {
    ids.push(fixtureId(rank * 4 + parity), fixtureId(rank * 4 + parity + 2));
  }
  return ids;
}

function fixtureId(index: number): string {
  return `${DENSE_VIEWPORT_FIXTURE_VERSION}-${index.toString().padStart(4, "0")}`;
}

function markerCenter(index: number): PointV1 {
  return { x: 20 + (index % 10) * 30, y: 20 + Math.floor(index / 10) * 30 };
}

function backgroundCenter(index: number): PointV1 {
  return {
    x: 340 + (index % 40) + index / 100_000,
    y: 20 + (index % 100) * 6,
  };
}

function midpoint(start: PointV1, end: PointV1): PointV1 {
  return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
}
