/**
 * Document-level bit-depth conversion and the display narrowing point.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let Document;
let allocPixelBuffer;

before(async () => {
  await import("../../../src/engine/layer-system.js");
  ({ Document } = await import("../../../src/document/model/document.js"));
  ({ allocPixelBuffer } = await import("../../../src/engine/compositing/pixel-depth.js"));
});

/** A document holding one layer whose pixels are `samples`, at `bitDepth`. */
function documentWithLayer(samples, bitDepth) {
  const doc = new Document("test");
  doc.width = samples.length / 4;
  doc.height = 1;
  doc.bitDepth = bitDepth;
  const buffer = allocPixelBuffer(samples.length / 4, bitDepth);
  samples.forEach((sample, i) => { buffer[i] = sample; });
  doc.layers = [{
    buffer: buffer,
    renderCache: { dispose() { this.disposed = true; }, needsRebuild: false, dirty: false },
  }];
  return doc;
}

describe("document/model/document.js bit depth", () => {
  it("starts at 8-bit RGB", () => {
    const doc = new Document("test");
    assert.equal(doc.bitDepth, 8);
    assert.equal(doc.colorMode, 3);
  });

  it("converts every layer's pixels and records the new depth", () => {
    const doc = documentWithLayer([255, 128, 0, 255], 8);

    doc.convertBitDepth(16);

    assert.equal(doc.bitDepth, 16);
    const converted = doc.layers[0].buffer;
    assert.ok(converted instanceof Uint16Array);
    assert.equal(converted[0], 65535, "white stays white");
    assert.equal(converted[3], 65535, "alpha rescales");
  });

  it("drops the composite buffer so it is rebuilt at the new depth", () => {
    const doc = documentWithLayer([10, 20, 30, 255], 8);
    doc.buffer = allocPixelBuffer(1, 8);

    doc.convertBitDepth(32);

    assert.equal(doc.buffer, null, "an 8-bit composite buffer cannot be reused");
    assert.equal(doc.needsComposite, true);
  });

  it("throws away render caches, which still hold old-depth textures", () => {
    const doc = documentWithLayer([10, 20, 30, 255], 8);

    doc.convertBitDepth(32);

    assert.equal(doc.layers[0].renderCache.disposed, true);
    assert.equal(doc.layers[0].renderCache.needsRebuild, true);
  });

  it("does nothing when the document is already at that depth", () => {
    const doc = documentWithLayer([10, 20, 30, 255], 8);
    const originalBuffer = doc.layers[0].buffer;

    doc.convertBitDepth(8);

    assert.equal(doc.layers[0].buffer, originalBuffer);
  });

  // Widening is lossless; narrowing is not, and says so.
  it("round-trips 8 -> 32 -> 8 without drift", () => {
    const doc = documentWithLayer([0, 64, 128, 255], 8);

    doc.convertBitDepth(32);
    doc.convertBitDepth(8);

    assert.deepEqual([...doc.layers[0].buffer], [0, 64, 128, 255]);
  });

  describe("getDisplayBuffer", () => {
    it("hands back the buffer itself at 8-bit, with no copy", () => {
      const doc = new Document("test");
      doc.buffer = allocPixelBuffer(1, 8);
      assert.equal(doc.getDisplayBuffer(), doc.buffer);
    });

    it("narrows a wider document to bytes for display", () => {
      const doc = new Document("test");
      doc.bitDepth = 32;
      doc.buffer = allocPixelBuffer(1, 32);
      doc.buffer[0] = 1; doc.buffer[1] = 0; doc.buffer[2] = 0; doc.buffer[3] = 1;

      const display = doc.getDisplayBuffer();

      assert.ok(display instanceof Uint8Array);
      assert.equal(display[0], 255);
      assert.equal(display[3], 255);
    });

    it("clips the range above white, which a canvas cannot show", () => {
      const doc = new Document("test");
      doc.bitDepth = 32;
      doc.buffer = allocPixelBuffer(1, 32);
      doc.buffer[0] = 6; doc.buffer[3] = 1;

      assert.equal(doc.getDisplayBuffer()[0], 255, "a 6.0 highlight clips at white");
      assert.equal(doc.buffer[0], 6, "but the document still holds it");
    });
  });
});
