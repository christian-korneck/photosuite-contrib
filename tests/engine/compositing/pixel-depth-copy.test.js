/**
 * Depth-generic region copy, against the 8-bit copy as the oracle.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let Rect;
let allocPixelBuffer;
let convertPixelBuffer;
let copyPixelRegion;
let copyPixels;

before(async () => {
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ allocPixelBuffer, convertPixelBuffer, copyPixelRegion } = await import(
    "../../../src/engine/compositing/pixel-depth.js"
  ));
  ({ copyPixels } = await import("../../../src/engine/compositing/pixel-ops.js"));
});

/** A buffer whose samples ascend, so a misplaced row is obvious. */
function rampBuffer(pixelCount, bitDepth) {
  const buffer = allocPixelBuffer(pixelCount, 8);
  for (let i = 0; i < buffer.length; i++) buffer[i] = i % 256;
  return convertPixelBuffer(buffer, bitDepth);
}

describe("engine/compositing/pixel-depth.js copyPixelRegion", () => {
  it("copies the same pixels the 8-bit word copy does", () => {
    const srcRect = new Rect(0, 0, 4, 4);
    const dstRect = new Rect(0, 0, 4, 4);
    const source = rampBuffer(16, 8);

    const viaWords = allocPixelBuffer(16, 8);
    copyPixels(source, srcRect, viaWords, dstRect, dstRect);
    const viaSamples = allocPixelBuffer(16, 8);
    copyPixelRegion(source, srcRect, viaSamples, dstRect, dstRect);

    assert.deepEqual([...viaSamples], [...viaWords]);
  });

  it("places an offset region identically to the word copy", () => {
    const srcRect = new Rect(0, 0, 4, 4);
    const dstRect = new Rect(1, 1, 4, 4);
    const clipRect = new Rect(1, 1, 2, 2);
    const source = rampBuffer(16, 8);

    const viaWords = allocPixelBuffer(16, 8);
    copyPixels(source, srcRect, viaWords, dstRect, clipRect);
    const viaSamples = allocPixelBuffer(16, 8);
    copyPixelRegion(source, srcRect, viaSamples, dstRect, clipRect);

    assert.deepEqual([...viaSamples], [...viaWords]);
  });

  // A 32-bit pixel is four words wide, so a word-at-a-time copy would move a
  // quarter of each row and interleave the rest.
  it("moves whole pixels at 16- and 32-bit", () => {
    for (const bitDepth of [16, 32]) {
      const srcRect = new Rect(0, 0, 4, 4);
      const dstRect = new Rect(0, 0, 4, 4);
      const source = rampBuffer(16, bitDepth);
      const dest = allocPixelBuffer(16, bitDepth);

      copyPixelRegion(source, srcRect, dest, dstRect, dstRect);

      assert.deepEqual([...dest], [...source], `${bitDepth}-bit copy`);
    }
  });

  it("copies only the clipped region, leaving the rest of the destination", () => {
    const srcRect = new Rect(0, 0, 2, 2);
    const dstRect = new Rect(0, 0, 2, 2);
    const source = rampBuffer(4, 32);
    const dest = allocPixelBuffer(4, 32);
    dest.fill(9);

    copyPixelRegion(source, srcRect, dest, dstRect, new Rect(0, 0, 1, 1));

    assert.deepEqual([...dest.subarray(0, 4)], [...source.subarray(0, 4)], "first pixel copied");
    assert.deepEqual([...dest.subarray(4)], [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9], "rest untouched");
  });

  it("does nothing when the rectangles do not meet", () => {
    const source = rampBuffer(4, 32);
    const dest = allocPixelBuffer(4, 32);
    dest.fill(7);

    copyPixelRegion(source, new Rect(0, 0, 2, 2), dest, new Rect(10, 10, 2, 2), null);

    assert.ok([...dest].every((sample) => sample === 7));
  });
});
