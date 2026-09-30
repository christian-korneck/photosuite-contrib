/**
 * Uploading a layer whose buffer is not at the document's depth.
 *
 * Reproduces: pasting into a 32-bit document threw
 * `texImage2D: pixels is not TypeFloat32`. The texture is created at the
 * document depth, but a layer made after the conversion — a paste, a new layer
 * — still holds bytes, and those went straight to a float texture.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let Layer;
let LayerSystem;
let Rect;
let allocPixelBuffer;

before(async () => {
  ({ LayerSystem } = await import("../../../src/engine/layer-system.js"));
  ({ Rect } = await import("../../../src/core/math/rect.js"));
  ({ Layer } = await import("../../../src/document/model/layer.js"));
  ({ allocPixelBuffer } = await import("../../../src/engine/compositing/pixel-depth.js"));
});

/**
 * Drive `getLayerTexture` with GL stubbed out, returning whatever buffer the
 * texture upload was handed.
 */
function uploadedBufferFor(layerBitDepth, docBitDepth) {
  const layer = new Layer();
  layer.rect = new Rect(0, 0, 2, 2);
  layer.buffer = allocPixelBuffer(4, layerBitDepth);
  layer.markDirty();

  let uploaded = null;
  const originalTexture = LayerSystem.RgbaTexture;
  const originalWebgl = LayerSystem.webglEnabled;
  LayerSystem.webglEnabled = true;
  LayerSystem.RgbaTexture = function(width, height, useLinearFilter, bitDepth) {
    this.width = width;
    this.height = height;
    this.bitDepth = bitDepth == null ? 8 : bitDepth;
    this.set = (pixelData) => { uploaded = pixelData; };
    this.delete = () => {};
  };
  try {
    layer.getLayerTexture({ bitDepth: docBitDepth });
  } finally {
    LayerSystem.RgbaTexture = originalTexture;
    LayerSystem.webglEnabled = originalWebgl;
  }
  return { uploaded, layer };
}

describe("document/model/layer.js texture depth", () => {
  it("uploads an 8-bit buffer as bytes for an 8-bit document", () => {
    const { uploaded } = uploadedBufferFor(8, 8);
    assert.ok(uploaded instanceof Uint8Array, "byte document, byte upload");
  });

  // The crash was a float texture handed a byte buffer. The texture has to be
  // built at the document's depth for `RgbaTexture.set` to conform to it —
  // conforming itself is covered in the layer-system tests.
  it("builds the layer texture at the document's depth, not the buffer's", () => {
    for (const docBitDepth of [16, 32]) {
      const layer = new Layer();
      layer.rect = new Rect(0, 0, 2, 2);
      layer.buffer = allocPixelBuffer(4, 8);
      layer.markDirty();

      let createdDepth = null;
      const originalTexture = LayerSystem.RgbaTexture;
      const originalWebgl = LayerSystem.webglEnabled;
      LayerSystem.webglEnabled = true;
      LayerSystem.RgbaTexture = function(width, height, useLinearFilter, bitDepth) {
        createdDepth = bitDepth;
        this.width = width;
        this.height = height;
        this.bitDepth = bitDepth;
        this.set = () => {};
        this.delete = () => {};
      };
      try {
        layer.getLayerTexture({ bitDepth: docBitDepth });
      } finally {
        LayerSystem.RgbaTexture = originalTexture;
        LayerSystem.webglEnabled = originalWebgl;
      }
      assert.equal(createdDepth, docBitDepth);
    }
  });

  // The layer's own buffer is shared with code that moves pixels a word at a
  // time through a `Uint32Array` view. Handing that a `Float32Array` reads four
  // floats as one packed pixel, which turned a pasted layer into dithered
  // noise — so the layer keeps its bytes and the texture conforms on upload.
  it("never rewrites the layer's own buffer to the document's depth", () => {
    const { layer } = uploadedBufferFor(8, 32);
    assert.ok(layer.buffer instanceof Uint8Array, "the layer still holds bytes");
  });
});
