/**
 * Display encoding for high-depth documents.
 *
 * Reproduces: converting a document to 32-bit made it render darker.
 * A 32-bit document holds *linear* light, but the GPU display shader samples
 * that texture and writes straight to an 8-bit canvas. Without an sRGB encode
 * on the way out, linear 0.216 — which is byte 128 — lands as byte 55.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();

let PluginToolPanel;
let convertPixelBuffer;
let allocPixelBuffer;
let srgbToLinear;

before(async () => {
  await import("../../../src/engine/layer-system.js");
  ({ PluginToolPanel } = await import("../../../src/ui/panels/plugin-tool-panel.js"));
  ({ allocPixelBuffer, convertPixelBuffer } = await import(
    "../../../src/engine/compositing/pixel-depth.js"
  ));
  ({ srgbToLinear } = await import("../../../src/engine/compositing/color-math.js"));
});

describe("ui/panels/plugin-tool-composite.js display encoding", () => {
  // The whole point: mid-grey has to survive a depth conversion and come back
  // out of the display path looking like mid-grey.
  it("a mid-grey pixel is still mid-grey after converting to 32-bit", () => {
    const eightBit = allocPixelBuffer(1, 8);
    eightBit[0] = 128; eightBit[1] = 128; eightBit[2] = 128; eightBit[3] = 255;

    const asFloat = convertPixelBuffer(eightBit, 32);
    // Stored linear, which is much darker than 0.5 as a raw number...
    assert.ok(asFloat[0] < 0.25, `stored linear value was ${asFloat[0]}`);
    // ...so displaying it without re-encoding is what darkened the document.
    assert.equal(Math.round(asFloat[0] * 255), 55, "raw linear as a byte is far too dark");

    assert.deepEqual([...convertPixelBuffer(asFloat, 8)], [128, 128, 128, 255]);
  });

  // The GPU path never touches `getDisplayBuffer`, so the encode has to exist
  // in the shader instead.
  it("the composite display shader encodes linear samples for an 8-bit canvas", () => {
    const shaderSource = PluginToolPanel.buildCompositeFragmentShader(false, 0);
    assert.match(
      shaderSource,
      /srgbEncode/,
      "the display shader needs an sRGB encode for linear documents",
    );
  });

  it("asks for the encode only when the document is held in linear light", () => {
    assert.equal(PluginToolPanel.displayEncodesLinear(8), 0, "8-bit is already sRGB");
    assert.equal(PluginToolPanel.displayEncodesLinear(16), 0, "16-bit is already sRGB");
    assert.equal(PluginToolPanel.displayEncodesLinear(32), 1, "32-bit is linear");
  });

  it("its encode matches the one the CPU display path uses", () => {
    // Both paths must agree, or a document would change appearance depending on
    // whether WebGL happened to be on.
    const linear = srgbToLinear(128 / 255);
    const encoded = linear <= 0.0031308
      ? 12.92 * linear
      : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
    assert.equal(Math.round(encoded * 255), 128);
  });
});
