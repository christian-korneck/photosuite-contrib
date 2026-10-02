/**
 * Radiance (.hdr / .pic) RGBE decoding.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let radianceCodec;
let LayerSystem;

before(async () => {
  ({ radianceCodec } = await import("../../../../src/document/formats/codecs/raster-hdr.js"));
  ({ LayerSystem } = await import("../../../../src/engine/layer-system.js"));
});

/**
 * Decode with float frames available. Keeping the linear samples needs a GPU
 * that can composite them, which the test environment has no context for.
 */
function decodeAsFloat(buffer) {
  const originalSupports = LayerSystem.supportsBitDepth;
  LayerSystem.supportsBitDepth = () => true;
  try {
    return radianceCodec.decode(buffer);
  } finally {
    LayerSystem.supportsBitDepth = originalSupports;
  }
}

/**
 * A flat (non-RLE) Radiance file of `width` x `height`, from RGBE quadruples.
 * @param {number[][]} rgbePixels
 */
function radianceFile(width, height, rgbePixels) {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
  const bytes = new Uint8Array(header.length + rgbePixels.length * 4);
  for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
  rgbePixels.forEach((pixel, pixelIdx) => {
    bytes.set(pixel, header.length + pixelIdx * 4);
  });
  return bytes.buffer;
}

/** RGBE for a mid-grey, exponent 128 means a scale of 1/256 per the format. */
const RGBE_HALF = [128, 128, 128, 128];

describe("document/formats/codecs/raster-hdr.js Radiance", () => {
  it("decodes a flat file into one float layer", () => {
    const frames = decodeAsFloat(radianceFile(2, 1, [RGBE_HALF, [255, 0, 0, 128]]));
    assert.equal(frames.length, 1);
    const frame = frames[0];
    assert.equal(frame.rect.width, 2);
    assert.equal(frame.rect.height, 1);
    assert.ok(frame.data instanceof Float32Array, `got a ${frame.data.constructor.name}`);
    assert.equal(frame.bitDepth, 32);
  });

  it("converts the shared exponent into linear light", () => {
    const frames = decodeAsFloat(radianceFile(1, 1, [RGBE_HALF]));
    const pixels = frames[0].data;
    // mantissa 128/256 with exponent 128 (bias 128) gives 0.5.
    assert.ok(Math.abs(pixels[0] - 0.5) < 0.01, `red decoded to ${pixels[0]}`);
    assert.equal(pixels[3], 1, "Radiance carries no alpha, so it is opaque");
  });

  // The point of the format: it stores light, not display values.
  it("keeps values above white", () => {
    // Exponent 131 scales the mantissa up by 8.
    const frames = decodeAsFloat(radianceFile(1, 1, [[128, 128, 128, 131]]));
    assert.ok(frames[0].data[0] > 3.9, `bright pixel decoded to ${frames[0].data[0]}`);
  });

  it("treats a zero exponent as black", () => {
    const frames = decodeAsFloat(radianceFile(1, 1, [[99, 99, 99, 0]]));
    assert.equal(frames[0].data[0], 0);
  });

  // Adaptive RLE applies only to scanlines 8 pixels and wider; narrower rows
  // are always flat, which is why the decoder checks the width before trusting
  // the 2,2 marker.
  it("decodes adaptive RLE scanlines", () => {
    const width = 8;
    const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X ${width}\n`;
    // Marker 2,2 then the width, then one repeat run per channel: a count byte
    // above 128 means "repeat the next byte count-128 times".
    const scanline = [2, 2, 0, width];
    for (let channel = 0; channel < 4; channel++) scanline.push(128 + width, 128);
    const bytes = new Uint8Array(header.length + scanline.length);
    for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
    bytes.set(scanline, header.length);

    const frames = decodeAsFloat(bytes.buffer);

    assert.equal(frames[0].rect.width, width);
    const pixels = frames[0].data;
    assert.ok(Math.abs(pixels[0] - 0.5) < 0.01, `first pixel ${pixels[0]}`);
    assert.ok(Math.abs(pixels[(width - 1) * 4] - 0.5) < 0.01, "the run filled the whole scanline");
  });

  // Without a float-capable GPU the file still opens, narrowed the way EXR
  // already is — and as bytes in the shape the loader expects, since
  // `new Uint8Array(floats)` converts element-wise and would import as black.
  it("narrows to display bytes when float frames are unavailable", () => {
    const originalSupports = LayerSystem.supportsBitDepth;
    LayerSystem.supportsBitDepth = () => false;
    try {
      const frames = radianceCodec.decode(radianceFile(1, 1, [RGBE_HALF]));
      const frame = frames[0];
      assert.ok(frame.data instanceof ArrayBuffer, `got a ${frame.data.constructor.name}`);
      assert.equal(frame.bitDepth, undefined, "a byte frame claims no depth");
      const bytes = new Uint8Array(frame.data);
      assert.ok(bytes[0] > 180, `mid-grey narrowed to ${bytes[0]}, expected an sRGB-encoded byte`);
      assert.equal(bytes[3], 255);
    } finally {
      LayerSystem.supportsBitDepth = originalSupports;
    }
  });

  it("rejects a file that is not Radiance", () => {
    const notRadiance = new Uint8Array([1, 2, 3, 4]).buffer;
    assert.throws(() => radianceCodec.decode(notRadiance), /Radiance/);
  });
});
