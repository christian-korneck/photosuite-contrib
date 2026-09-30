/**
 * Layer previews for a high-depth document.
 *
 * Reproduces: layer previews rendered fully transparent at 32-bit. The
 * thumbnail reads alpha as `rgba[i + 3] * (1/255)`, so a float alpha of 1.0
 * became 0.0039 — every pixel drawn as bare checkerboard.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";

installBrowserGlobals();

let LayerThumbnails;
let Rect;
let allocPixelBuffer;
let convertPixelBuffer;

before(async () => {
  ({ Rect } = await import("../../src/core/math/rect.js"));
  ({ LayerThumbnails } = await import("../../src/document/layer-thumbnails.js"));
  ({ allocPixelBuffer, convertPixelBuffer } = await import(
    "../../src/engine/compositing/pixel-depth.js"
  ));
});

/** A 2D context stub that records the ImageData it is given. */
function stubContext() {
  const painted = { imageData: null };
  return {
    painted,
    canvas: { width: 0, height: 0, style: {} },
    createImageData: (width, height) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: (imageData) => { painted.imageData = imageData; },
    getImageData: (x, y, width, height) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }),
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fillRect() {}, clearRect() {}, setTransform() {}, scale() {},
  };
}

/** A solid opaque red 4x4 layer at `bitDepth`. */
function redLayerBuffer(bitDepth) {
  const eightBit = allocPixelBuffer(16, 8);
  for (let pixel = 0; pixel < 16; pixel++) {
    eightBit[pixel * 4] = 220;
    eightBit[pixel * 4 + 1] = 30;
    eightBit[pixel * 4 + 2] = 30;
    eightBit[pixel * 4 + 3] = 255;
  }
  return convertPixelBuffer(eightBit, bitDepth);
}

/** The centre pixel the thumbnail painted, as RGBA bytes. */
function paintedCentrePixel(bitDepth) {
  const ctx = stubContext();
  const rect = new Rect(0, 0, 4, 4);
  LayerThumbnails.drawRasterThumbnail(ctx, 4, 4, rect, redLayerBuffer(bitDepth), rect, false);
  const painted = ctx.painted.imageData;
  assert.ok(painted != null, "the thumbnail painted something");
  const centreIdx = (2 * painted.width + 2) * 4;
  return [...painted.data.subarray(centreIdx, centreIdx + 4)];
}

describe("document/layer-thumbnails.js at depth", () => {
  it("draws an 8-bit layer's colour", () => {
    const [red, green, blue] = paintedCentrePixel(8);
    assert.ok(red > 200, `red was ${red}`);
    assert.ok(green < 60 && blue < 60, `green/blue were ${green}/${blue}`);
  });

  // The bug: float alpha read as a byte made every pixel transparent, so the
  // preview showed only the checkerboard.
  it("draws a 32-bit layer's colour rather than an empty checkerboard", () => {
    const [red, green, blue] = paintedCentrePixel(32);
    assert.ok(red > 200, `red was ${red} — a transparent preview leaves checkerboard grey`);
    assert.ok(green < 60 && blue < 60, `green/blue were ${green}/${blue}`);
  });

  it("does the same for 16-bit", () => {
    const [red, green, blue] = paintedCentrePixel(16);
    assert.ok(red > 200, `red was ${red}`);
    assert.ok(green < 60 && blue < 60, `green/blue were ${green}/${blue}`);
  });
});
