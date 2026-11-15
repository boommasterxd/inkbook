import { imageElement } from "../domain/images";
import { createImageResource } from "../../../src/persistence/images/image-resources";
import { TestWorkScheduler } from "./work-scheduler";

/** Real 16 x 16 progressive JPEG, generated with ImageMagick from a solid red image. */
export function progressiveJpegBytes() {
  return Uint8Array.from(
    atob(
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wgARCAAQABADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAWAQEBAQAAAAAAAAAAAAAAAAAABgj/2gAMAwEAAhADEAAAAZzC6pAH/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABBQIf/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAwEBPwEf/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAgEBPwEf/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQAGPwIf/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABPyEf/9oADAMBAAIAAwAAABD/AP8A/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAwEBPxAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAIP/aAAgBAgEBPxAf/8QAFBABAAAAAAAAAAAAAAAAAAAAIP/aAAgBAQABPxAf/9k=",
    ),
    (character) => character.charCodeAt(0),
  );
}

export function validImageResource() {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
  return createImageResource(bytes, "image/png", new TestWorkScheduler());
}

/** A real 2000 x 2000 monochrome PNG keeps the capacity test independent of raster allocation. */
export async function capacityImageResource(index: number) {
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAB9AAAAfQAQAAAACyQ/nUAAAB/UlEQVR42u3BAQ0AAADCoPdPbQ43oAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHg2qVkAAdbjW0oAAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
  const payload = new TextEncoder().encode(`tEXtcase\0${index}`);
  const chunk = new Uint8Array(payload.length + 8);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, payload.length - 4);
  chunk.set(payload, 4);
  let crc = 0xffffffff;
  for (const byte of payload) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) === 0 ? 0 : 0xedb88320);
  }
  view.setUint32(chunk.length - 4, (crc ^ 0xffffffff) >>> 0);
  const bytes = new Uint8Array(png.length + chunk.length);
  bytes.set(png.subarray(0, png.length - 12));
  bytes.set(chunk, png.length - 12);
  bytes.set(png.subarray(png.length - 12), png.length - 12 + chunk.length);
  return createImageResource(bytes, "image/png", new TestWorkScheduler());
}

/** Bind a real raster to a source-parallel image element with a complete source crop. */
export async function validImageFixture() {
  const asset = await validImageResource();
  return {
    asset,
    element: {
      ...imageElement(),
      assetId: asset.id,
      crop: { x: 0, y: 0, width: asset.width, height: asset.height },
    },
  };
}

/** Source-container dimensions for tests that replace the native decoder boundary. */
export function imageHeaderBytes(bytes: Uint8Array, width: number, height: number) {
  const source = new Uint8Array(bytes);
  const view = new DataView(source.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return source;
}
