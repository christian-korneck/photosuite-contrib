/**
 * Pixel storage at 8/16/32 bits per channel, and conversion between them.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let allocPixelBuffer;
let bitDepthOfBuffer;
let bytesPerPixel;
let convertPixelBuffer;
let convertColorSample;
let fillPixelBuffer;
let isSupportedBitDepth;
let pixelArrayType;
let rescaleAlpha;

before(async () => {
  ({
    allocPixelBuffer,
    bitDepthOfBuffer,
    bytesPerPixel,
    convertPixelBuffer,
    convertColorSample,
    fillPixelBuffer,
    isSupportedBitDepth,
    pixelArrayType,
    rescaleAlpha,
  } = await import("../../../src/engine/compositing/pixel-depth.js"));
});

/** One RGBA pixel at `bitDepth`, from four samples. */
function pixelAt(bitDepth, samples) {
  const buffer = allocPixelBuffer(1, bitDepth);
  samples.forEach((sample, i) => { buffer[i] = sample; });
  return buffer;
}

describe("engine/compositing/pixel-depth.js", () => {
  it("allocates four samples per pixel at every depth, in the right type", () => {
    assert.equal(pixelArrayType(8), Uint8Array);
    assert.equal(pixelArrayType(16), Uint16Array);
    assert.equal(pixelArrayType(32), Float32Array);
    for (const bitDepth of [8, 16, 32]) {
      const buffer = allocPixelBuffer(10, bitDepth);
      // Length counts samples, not bytes, so pixel count reads the same way at
      // every depth — callers doing `length >>> 2` keep working.
      assert.equal(buffer.length, 40, `length at ${bitDepth}-bit`);
      assert.equal(buffer.byteLength, 10 * bytesPerPixel(bitDepth), `bytes at ${bitDepth}-bit`);
      assert.equal(bitDepthOfBuffer(buffer), bitDepth);
      assert.ok([...buffer].every((sample) => sample === 0), "starts zeroed");
    }
  });

  it("only 8, 16 and 32 are supported depths", () => {
    assert.deepEqual([8, 16, 32].map(isSupportedBitDepth), [true, true, true]);
    assert.deepEqual([1, 4, 24, 64].map(isSupportedBitDepth), [false, false, false, false]);
    assert.throws(() => pixelArrayType(24), /unsupported bit depth: 24/);
  });

  // 8 <-> 16 is a pure rescale: both depths are sRGB-encoded.
  describe("8 <-> 16 bit", () => {
    it("scales by 257 so black and white stay exact", () => {
      assert.equal(convertColorSample(0, 8, 16), 0);
      assert.equal(convertColorSample(255, 8, 16), 65535);
      assert.equal(convertColorSample(0, 16, 8), 0);
      assert.equal(convertColorSample(65535, 16, 8), 255);
    });

    it("round-trips every 8-bit level without drift", () => {
      for (let level = 0; level <= 255; level++) {
        const roundTripped = convertColorSample(convertColorSample(level, 8, 16), 16, 8);
        assert.equal(roundTripped, level, `level ${level}`);
      }
    });

    it("rounds rather than truncating, which is what the high-byte read got wrong", () => {
      // 511 >> 8 is 1; the true value is 511/257 = 1.988.
      assert.equal(convertColorSample(511, 16, 8), 2);
    });
  });

  // Crossing 32-bit crosses the sRGB transfer curve, because 32-bit is linear.
  describe("8/16 <-> 32 bit", () => {
    it("decodes to linear on the way up and re-encodes on the way down", () => {
      const midGrey = convertColorSample(128, 8, 32);
      // Mid-grey sRGB is a long way below 0.5 in linear light; scaling straight
      // across instead is what made 32-bit PSDs open dark.
      assert.ok(midGrey > 0.21 && midGrey < 0.22, `linear mid-grey was ${midGrey}`);
      assert.equal(convertColorSample(midGrey, 32, 8), 128);
    });

    it("keeps black and white exact across the curve", () => {
      assert.equal(convertColorSample(0, 8, 32), 0);
      assert.equal(convertColorSample(1, 32, 8), 255);
      assert.equal(convertColorSample(0, 16, 32), 0);
      assert.equal(convertColorSample(1, 32, 16), 65535);
    });

    it("round-trips every 8-bit level through linear", () => {
      for (let level = 0; level <= 255; level++) {
        const roundTripped = convertColorSample(convertColorSample(level, 8, 32), 32, 8);
        assert.equal(roundTripped, level, `level ${level}`);
      }
    });

    it("clamps the range above white only when leaving 32-bit", () => {
      // The whole point of 32-bit: values past white survive in float...
      const hdr = pixelAt(32, [4.5, 2, 1.25, 1]);
      assert.equal(hdr[0], 4.5);
      // ...and an integer depth has nowhere to put them, so they clip to white.
      const asBytes = convertPixelBuffer(hdr, 8);
      assert.deepEqual([...asBytes], [255, 255, 255, 255]);
    });

    it("treats negative and NaN samples as black", () => {
      assert.equal(convertColorSample(-0.5, 32, 8), 0);
      assert.equal(convertColorSample(Number.NaN, 32, 8), 0);
    });
  });

  // Alpha is coverage, not colour: gamma-encoding it would distort compositing.
  describe("alpha", () => {
    it("rescales without crossing the transfer curve", () => {
      assert.equal(rescaleAlpha(128, 8, 32), 128 / 255);
      assert.equal(rescaleAlpha(0.5, 32, 8), 128);
      assert.equal(rescaleAlpha(255, 8, 16), 65535);
    });

    it("is converted differently from the colour samples beside it", () => {
      // Same stored value in every channel, so any difference is the curve.
      const grey = pixelAt(8, [128, 128, 128, 128]);
      const asFloat = convertPixelBuffer(grey, 32);
      // Math.fround because storing into a Float32Array rounds to float32.
      assert.equal(asFloat[3], Math.fround(128 / 255));
      assert.notEqual(asFloat[0], asFloat[3]);
      assert.deepEqual([...convertPixelBuffer(asFloat, 8)], [128, 128, 128, 128]);
    });
  });

  // The byte fill writes a colour as one 32-bit word, which is one pixel only
  // at 8-bit; wider buffers have to unpack it and write per sample.
  describe("fillPixelBuffer", () => {
    it("fills every pixel with the unpacked colour", () => {
      const buffer = allocPixelBuffer(3, 16);
      // Alpha in the top byte, then three colour channels.
      fillPixelBuffer(buffer, (255 << 24 | 30 << 16 | 20 << 8 | 10) >>> 0);
      assert.deepEqual([...buffer], [
        10 * 257, 20 * 257, 30 * 257, 65535,
        10 * 257, 20 * 257, 30 * 257, 65535,
        10 * 257, 20 * 257, 30 * 257, 65535,
      ]);
    });

    it("takes colour through the transfer curve and alpha past it", () => {
      const buffer = allocPixelBuffer(1, 32);
      fillPixelBuffer(buffer, (128 << 24 | 128 << 16 | 128 << 8 | 128) >>> 0);
      assert.ok(buffer[0] > 0.21 && buffer[0] < 0.22, `colour was ${buffer[0]}`);
      assert.equal(buffer[3], Math.fround(128 / 255), "alpha only rescales");
    });

    it("fills an 8-bit buffer with the plain byte values", () => {
      const buffer = allocPixelBuffer(1, 8);
      fillPixelBuffer(buffer, (255 << 24 | 3 << 16 | 2 << 8 | 1) >>> 0);
      assert.deepEqual([...buffer], [1, 2, 3, 255]);
    });
  });

  it("returns the same buffer when the depth already matches", () => {
    const buffer = allocPixelBuffer(4, 16);
    assert.equal(convertPixelBuffer(buffer, 16), buffer);
  });

  it("converts whole buffers a pixel at a time, preserving channel order", () => {
    const rgba = pixelAt(8, [10, 20, 30, 40]);
    const asShorts = convertPixelBuffer(rgba, 16);
    assert.equal(bitDepthOfBuffer(asShorts), 16);
    assert.deepEqual([...asShorts], [10 * 257, 20 * 257, 30 * 257, 40 * 257]);
    assert.deepEqual([...convertPixelBuffer(asShorts, 8)], [10, 20, 30, 40]);
  });
});
