/**
 * 16/32-bit compositing, checked against the 8-bit pipeline as the oracle.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let Rect;
let composite;
let compositeHighDepth;
let allocPixelBuffer;
let convertPixelBuffer;

before(async () => {
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ composite } = await import("../../../src/engine/compositing/compositing-ops.js"));
  ({ compositeHighDepth } = await import(
    "../../../src/engine/compositing/compositing-ops-high-depth.js"
  ));
  ({ allocPixelBuffer, convertPixelBuffer } = await import(
    "../../../src/engine/compositing/pixel-depth.js"
  ));
});

/** An 8-bit RGBA buffer from a flat list of samples. */
function bytes(samples) {
  const buffer = allocPixelBuffer(samples.length / 4, 8);
  samples.forEach((sample, i) => { buffer[i] = sample; });
  return buffer;
}

/**
 * Blend one pixel over another at 8-bit and again at `bitDepth`, returning both
 * results as 8-bit so they can be compared directly.
 */
function blendBothDepths(mode, srcSamples, dstSamples, bitDepth, opacity = 1) {
  const rect = new Rect(0, 0, srcSamples.length / 4, 1);
  const eightBitDst = bytes(dstSamples);
  composite(mode, bytes(srcSamples), rect, eightBitDst, rect, rect, opacity, null);

  const highSrc = convertPixelBuffer(bytes(srcSamples), bitDepth);
  const highDst = convertPixelBuffer(bytes(dstSamples), bitDepth);
  compositeHighDepth(mode, highSrc, rect, highDst, rect, rect, opacity, null);

  return { eightBit: [...eightBitDst], high: [...convertPixelBuffer(highDst, bitDepth === 32 ? 8 : 8)] };
}

/** Assert two 8-bit results agree within `tolerance` levels per sample. */
function assertAgrees(actual, expected, tolerance, label) {
  assert.equal(actual.length, expected.length, label);
  for (let i = 0; i < expected.length; i++) {
    const delta = Math.abs(actual[i] - expected[i]);
    assert.ok(
      delta <= tolerance,
      `${label}: sample ${i} was ${actual[i]}, 8-bit gave ${expected[i]} (delta ${delta})`,
    );
  }
}

// Every mode the high-depth compositor routes, across both blend families.
const MODES = [
  "norm", "dark", "mul ", "lite", "scrn", "over", "diff",
  "idiv", "lbrn", "div ", "lddg", "sLit", "hLit", "vLit", "lLit", "pLit", "hMix",
  "dkCl", "lgCl", "hue ", "sat ", "colr", "lum ",
];

describe("engine/compositing/compositing-ops-high-depth.js", () => {
  // 16-bit is sRGB-encoded like 8-bit, so the same blend maths must land on the
  // same colour. Rounding differs by at most a level.
  describe("16-bit agrees with the 8-bit pipeline", () => {
    const src = [200, 120, 40, 255, 30, 220, 90, 128];
    const dst = [60, 180, 240, 255, 210, 70, 150, 255];

    for (const mode of MODES) {
      it(`blends "${mode.trim()}" the same way`, () => {
        const { eightBit, high } = blendBothDepths(mode, src, dst, 16);
        assertAgrees(high, eightBit, 1, mode);
      });
    }

    it("matches at partial opacity too", () => {
      const { eightBit, high } = blendBothDepths("mul ", src, dst, 16, 0.35);
      assertAgrees(high, eightBit, 1, "multiply at 0.35 opacity");
    });

    it("leaves the destination alone where the source is fully transparent", () => {
      const { eightBit, high } = blendBothDepths(
        "norm", [200, 120, 40, 0], [60, 180, 240, 255], 16,
      );
      assert.deepEqual(eightBit, [60, 180, 240, 255]);
      assertAgrees(high, eightBit, 0, "transparent source");
    });
  });

  // 32-bit is linear, so a round trip through it is only expected to land in
  // the same neighbourhood — the curve costs precision in the darks.
  describe("32-bit", () => {
    it("blends normally over an opaque destination", () => {
      const { eightBit, high } = blendBothDepths(
        "norm", [200, 120, 40, 255], [60, 180, 240, 255], 32,
      );
      assertAgrees(high, eightBit, 1, "normal at 32-bit");
    });

    it("keeps highlights above white instead of clipping them", () => {
      const rect = new Rect(0, 0, 1, 1);
      const src = allocPixelBuffer(1, 32);
      // A source four times brighter than white, fully opaque.
      src[0] = 4; src[1] = 2; src[2] = 1.5; src[3] = 1;
      const dst = allocPixelBuffer(1, 32);
      dst[0] = 0.5; dst[1] = 0.5; dst[2] = 0.5; dst[3] = 1;

      compositeHighDepth("norm", src, rect, dst, rect, rect, 1, null);

      assert.ok(dst[0] > 3.9, `red stayed ${dst[0]}, expected to survive above 1.0`);
      assert.ok(dst[1] > 1.9, `green stayed ${dst[1]}`);
      assert.equal(dst[3], 1);
    });

    // Known limit, and the boundary of what this step covers: the pipeline
    // carries values above white, but the blend functions are shared with the
    // 8-bit path and several clamp internally — `lddgF` is `min(1, a + b)`.
    // They cannot simply stop clamping, because the 8-bit path packs results
    // with `<< 16` and an unclamped value would spill into the next channel.
    // Depth-aware blend variants are the next step; until then, modes that
    // clamp still clamp at 32-bit.
    it("still clamps in blend modes whose function clamps internally", () => {
      const rect = new Rect(0, 0, 1, 1);
      const src = allocPixelBuffer(1, 32);
      src[0] = 2; src[1] = 2; src[2] = 2; src[3] = 1;
      const dst = allocPixelBuffer(1, 32);
      dst[0] = 3; dst[1] = 3; dst[2] = 3; dst[3] = 1;

      compositeHighDepth("lddg", src, rect, dst, rect, rect, 1, null);

      assert.equal(dst[0], 1, "linear dodge saturates at white for now");
    });

    it("still clamps alpha, which is coverage rather than light", () => {
      const rect = new Rect(0, 0, 1, 1);
      const src = allocPixelBuffer(1, 32);
      src[0] = 8; src[1] = 8; src[2] = 8; src[3] = 1;
      const dst = allocPixelBuffer(1, 32);
      dst[3] = 1;

      compositeHighDepth("norm", src, rect, dst, rect, rect, 1, null);

      assert.equal(dst[3], 1, "alpha never exceeds full coverage");
    });

    it("never writes a negative sample", () => {
      const rect = new Rect(0, 0, 1, 1);
      const src = allocPixelBuffer(1, 32);
      src[0] = -2; src[1] = 0.5; src[2] = 0.5; src[3] = 1;
      const dst = allocPixelBuffer(1, 32);
      dst[0] = 0.5; dst[1] = 0.5; dst[2] = 0.5; dst[3] = 1;

      compositeHighDepth("norm", src, rect, dst, rect, rect, 1, null);

      assert.equal(dst[0], 0);
    });
  });

  it("refuses to blend buffers of different depths", () => {
    const rect = new Rect(0, 0, 1, 1);
    assert.throws(
      () => compositeHighDepth(
        "norm", allocPixelBuffer(1, 32), rect, allocPixelBuffer(1, 16), rect, rect, 1, null,
      ),
      /depth mismatch 32 over 16/,
    );
  });
});
