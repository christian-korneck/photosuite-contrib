/**
 * Extracting a selection from a high-depth layer.
 *
 * Reproduces: "new layer via copy" on a 32-bit document produced a near-white,
 * faintly noisy rectangle. The selection helpers work in packed bytes — word
 * copies and byte channel extraction — so float samples were read four-floats-
 * to-a-pixel, and alpha 1.0 came back as byte 1 instead of 255.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let Layer;
let Rect;
let allocPixelBuffer;
let convertPixelBuffer;

before(async () => {
  await import("../../../src/engine/layer-system.js");
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ Layer } = await import("../../../src/document/model/layer.js"));
  ({ allocPixelBuffer, convertPixelBuffer } = await import(
    "../../../src/engine/compositing/pixel-depth.js"
  ));
});

/** A 2x2 layer holding `samples` at `bitDepth`, fully opaque. */
function layerAt(bitDepth) {
  const layer = new Layer();
  layer.rect = new Rect(0, 0, 2, 2);
  const eightBit = allocPixelBuffer(4, 8);
  for (let pixel = 0; pixel < 4; pixel++) {
    eightBit[pixel * 4] = 200;
    eightBit[pixel * 4 + 1] = 100;
    eightBit[pixel * 4 + 2] = 50;
    eightBit[pixel * 4 + 3] = 255;
  }
  layer.buffer = convertPixelBuffer(eightBit, bitDepth);
  layer.pixelContent = 0;
  return layer;
}

/** A selection covering the whole layer. */
function fullSelection() {
  const channel = new Uint8Array(4);
  channel.fill(255);
  return { channel, rect: new Rect(0, 0, 2, 2) };
}

describe("document/model/layer.js selection extraction at depth", () => {
  it("extracts an 8-bit layer's pixels unchanged", () => {
    const layer = layerAt(8);
    const pixels = layer.computeSelectionPixels({ selectionMask: fullSelection() }, fullSelection(), true);
    assert.ok(pixels != null);
    assert.deepEqual([...pixels.selectionPixels.subarray(0, 4)], [200, 100, 50, 255]);
  });

  // The bug: float samples read as bytes gave near-white colour and an alpha of
  // 1 rather than 255, which is why the copied region came out barely visible.
  it("extracts a 32-bit layer's pixels as sane bytes, not reinterpreted floats", () => {
    const layer = layerAt(32);
    const pixels = layer.computeSelectionPixels({ selectionMask: fullSelection() }, fullSelection(), true);
    assert.ok(pixels != null);
    const extracted = [...pixels.selectionPixels.subarray(0, 4)];
    assert.equal(extracted[3], 255, "alpha survives as full coverage");
    // Within a level of the original, allowing the linear round trip.
    assert.ok(Math.abs(extracted[0] - 200) <= 1, `red came back as ${extracted[0]}`);
    assert.ok(Math.abs(extracted[1] - 100) <= 1, `green came back as ${extracted[1]}`);
    assert.ok(Math.abs(extracted[2] - 50) <= 1, `blue came back as ${extracted[2]}`);
  });

  it("does the same for 16-bit", () => {
    const layer = layerAt(16);
    const pixels = layer.computeSelectionPixels({ selectionMask: fullSelection() }, fullSelection(), true);
    const extracted = [...pixels.selectionPixels.subarray(0, 4)];
    assert.equal(extracted[3], 255);
    assert.ok(Math.abs(extracted[0] - 200) <= 1, `red came back as ${extracted[0]}`);
  });
});
