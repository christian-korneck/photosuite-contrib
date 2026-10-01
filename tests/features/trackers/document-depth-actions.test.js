/**
 * Image ▸ Mode bit-depth conversion, and its snapshot-based undo.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();
globalThis.SmartFilterBase = globalThis.SmartFilterBase || {};

let LayerEffectsTracker;
let CONVERT_MODE_ACTION;
let allocPixelBuffer;

before(async () => {
  const { TrackerRegistry } = await import("../../../src/features/trackers/tracker-registry.js");
  TrackerRegistry.LayerEffectsTracker = TrackerRegistry.LayerEffectsTracker || {
    copyContentFillToDescriptor() {},
  };
  await import("../../../src/features/trackers/layer-effects-actions.js");
  ({ LayerEffectsTracker } = await import("../../../src/features/trackers/layer-effects-tracker.js"));
  ({ CONVERT_MODE_ACTION } = await import("../../../src/features/trackers/document-depth-actions.js"));
  ({ allocPixelBuffer } = await import("../../../src/engine/compositing/pixel-depth.js"));
});

/** A minimal document whose single layer holds `samples` at `bitDepth`. */
function fakeDocument(samples, bitDepth) {
  const buffer = allocPixelBuffer(samples.length / 4, bitDepth);
  samples.forEach((sample, i) => { buffer[i] = sample; });
  const history = [];
  return {
    bitDepth,
    buffer: null,
    glTexture: null,
    needsComposite: false,
    stateChanged: false,
    layers: [{
      buffer,
      renderCache: { dispose() {}, needsRebuild: false, dirty: false },
    }],
    history,
    pushHistory(entry) { history.push(entry); },
    convertBitDepth(targetDepth) {
      const { convertPixelBuffer } = convertModule;
      if (targetDepth === this.bitDepth) return;
      for (const layer of this.layers) {
        if (layer.buffer != null) layer.buffer = convertPixelBuffer(layer.buffer, targetDepth);
      }
      this.bitDepth = targetDepth;
      this.buffer = null;
      this.needsComposite = true;
    },
  };
}

let convertModule;
before(async () => {
  convertModule = await import("../../../src/engine/compositing/pixel-depth.js");
});

/** Run the registered action handler the way the tracker would. */
function dispatchConvert(doc, targetDepth) {
  const tracker = new LayerEffectsTracker();
  LayerEffectsTracker.actionHandlers[CONVERT_MODE_ACTION].call(
    tracker, { actionKind: CONVERT_MODE_ACTION, targetDepth }, null, doc,
  );
  return tracker;
}

describe("features/trackers/document-depth-actions.js", () => {
  it("registers an action, an undo and a redo for convertMode", () => {
    assert.equal(typeof LayerEffectsTracker.actionHandlers[CONVERT_MODE_ACTION], "function");
    assert.equal(typeof LayerEffectsTracker.undoHandlers[CONVERT_MODE_ACTION], "function");
    assert.equal(typeof LayerEffectsTracker.redoHandlers[CONVERT_MODE_ACTION], "function");
  });

  it("converts the document and records one history step", () => {
    const doc = fakeDocument([255, 128, 0, 255], 8);

    dispatchConvert(doc, 16);

    assert.equal(doc.bitDepth, 16);
    assert.ok(doc.layers[0].buffer instanceof Uint16Array);
    assert.equal(doc.history.length, 1);
    assert.equal(doc.history[0].name, "dialogs.convertMode");
  });

  it("does nothing when the document is already at that depth", () => {
    const doc = fakeDocument([255, 128, 0, 255], 8);

    dispatchConvert(doc, 8);

    assert.equal(doc.history.length, 0, "a no-op does not clutter history");
  });

  it("ignores a colour mode with no conversion engine behind it", () => {
    const doc = fakeDocument([255, 128, 0, 255], 8);

    const tracker = new LayerEffectsTracker();
    LayerEffectsTracker.actionHandlers[CONVERT_MODE_ACTION].call(
      tracker, { actionKind: CONVERT_MODE_ACTION, targetMode: 4 }, null, doc,
    );

    assert.equal(doc.bitDepth, 8);
    assert.equal(doc.history.length, 0);
  });

  // Narrowing discards the range above white, so undo cannot re-convert — it
  // has to put the original samples back.
  describe("undo", () => {
    it("restores the exact pixels a narrowing conversion discarded", () => {
      const doc = fakeDocument([0, 0, 0, 0], 32);
      const hdr = doc.layers[0].buffer;
      hdr[0] = 4.5; hdr[1] = 2; hdr[2] = 0.5; hdr[3] = 1;

      const tracker = dispatchConvert(doc, 8);
      assert.equal(doc.bitDepth, 8);
      assert.equal(doc.layers[0].buffer[0], 255, "the highlight clipped on the way down");

      LayerEffectsTracker.undoHandlers[CONVERT_MODE_ACTION].call(
        tracker, doc.history[0].data, doc,
      );

      assert.equal(doc.bitDepth, 32);
      assert.equal(doc.layers[0].buffer[0], 4.5, "the 4.5 highlight is back");
      assert.equal(doc.layers[0].buffer[1], 2);
    });

    it("snapshots the original buffer rather than a copy of the converted one", () => {
      const doc = fakeDocument([10, 20, 30, 255], 8);
      const originalBuffer = doc.layers[0].buffer;

      dispatchConvert(doc, 32);

      assert.notEqual(doc.layers[0].buffer, originalBuffer, "conversion replaces the buffer");
      assert.equal(doc.history[0].data.layerBuffersBefore[0], originalBuffer,
        "history holds the original array itself, so no copy was taken");
    });

    it("forces a recomposite, since the composite buffer was at the other depth", () => {
      const doc = fakeDocument([10, 20, 30, 255], 8);
      const tracker = dispatchConvert(doc, 16);
      doc.needsComposite = false;

      LayerEffectsTracker.undoHandlers[CONVERT_MODE_ACTION].call(tracker, doc.history[0].data, doc);

      assert.equal(doc.needsComposite, true);
      assert.equal(doc.buffer, null);
    });
  });

  // Greyscale replaces each layer's buffer rather than editing it, so the
  // snapshot history holds stays intact and undo brings the colour back.
  describe("colour mode", () => {
    it("converts to greyscale and records a history step", () => {
      const doc = fakeDocument([255, 0, 0, 255], 8);
      doc.colorMode = 3;
      doc.convertColorMode = function(mode) {
        this.colorMode = mode;
        this.layers[0].buffer = new Uint8Array([76, 76, 76, 255]);
      };

      const tracker = new LayerEffectsTracker();
      LayerEffectsTracker.actionHandlers[CONVERT_MODE_ACTION].call(
        tracker, { actionKind: CONVERT_MODE_ACTION, targetMode: 1 }, null, doc,
      );

      assert.equal(doc.colorMode, 1);
      assert.equal(doc.history.length, 1);
    });

    it("undo restores both the colour mode and the original pixels", () => {
      const doc = fakeDocument([255, 0, 0, 255], 8);
      doc.colorMode = 3;
      const originalBuffer = doc.layers[0].buffer;
      doc.convertColorMode = function(mode) {
        this.colorMode = mode;
        this.layers[0].buffer = new Uint8Array([76, 76, 76, 255]);
      };

      const tracker = new LayerEffectsTracker();
      LayerEffectsTracker.actionHandlers[CONVERT_MODE_ACTION].call(
        tracker, { actionKind: CONVERT_MODE_ACTION, targetMode: 1 }, null, doc,
      );
      LayerEffectsTracker.undoHandlers[CONVERT_MODE_ACTION].call(tracker, doc.history[0].data, doc);

      assert.equal(doc.colorMode, 3, "back to RGB");
      assert.equal(doc.layers[0].buffer, originalBuffer, "the original pixels are back");
    });

    it("ignores a mode the document is already in", () => {
      const doc = fakeDocument([255, 0, 0, 255], 8);
      doc.colorMode = 3;

      const tracker = new LayerEffectsTracker();
      LayerEffectsTracker.actionHandlers[CONVERT_MODE_ACTION].call(
        tracker, { actionKind: CONVERT_MODE_ACTION, targetMode: 3 }, null, doc,
      );

      assert.equal(doc.history.length, 0);
    });
  });

  it("redo re-applies the conversion after an undo", () => {
    const doc = fakeDocument([10, 20, 30, 255], 8);
    const tracker = dispatchConvert(doc, 16);
    LayerEffectsTracker.undoHandlers[CONVERT_MODE_ACTION].call(tracker, doc.history[0].data, doc);
    assert.equal(doc.bitDepth, 8);

    LayerEffectsTracker.redoHandlers[CONVERT_MODE_ACTION].call(tracker, doc.history[0].data, doc);

    assert.equal(doc.bitDepth, 16);
    assert.ok(doc.layers[0].buffer instanceof Uint16Array);
  });
});
