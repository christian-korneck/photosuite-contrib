/**
 * Image/Layer menu builders.
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../../helpers/stub-browser-globals.js";

installBrowserGlobals();
globalThis.SmartFilterBase = globalThis.SmartFilterBase || {};

let buildImageMenu;
let TrackerRegistry;
let buildLayerMenu;
let ColorMode;
let LayerSystem;

before(async () => {
  ({ TrackerRegistry } = await import(
    "../../../src/features/trackers/tracker-registry.js"
  ));
  TrackerRegistry.LayerEffectsTracker = TrackerRegistry.LayerEffectsTracker || {
    copyContentFillToDescriptor() {},
  };
  await import("../../../src/document/tools/paint-tools.js");
  await import("../../../src/document/tools/pen-path-tools.js");
  await import("../../../src/document/tools/selection-tools.js");
  await import("../../../src/document/tools/lasso-tools.js");
  await import("../../../src/document/tools/crop-tools.js");
  await import("../../../src/document/tools/retouch-tools.js");
  await import("../../../src/document/tools/shape-tools.js");
  await import("../../../src/document/tools/view-tools.js");
  await import("../../../src/document/tools/move-tools.js");
  await import("../../../src/document/tools/text-tools.js");
  await import("../../../src/document/transform/transform-tools.js");
  ({ buildImageMenu, buildLayerMenu } = await import(
    "../../../src/ui/menu/menu-bar-image-layer-menus.js"
  ));
  ({ ColorMode } = await import("../../../src/document/model/document.js"));
  ({ LayerSystem } = await import("../../../src/engine/layer-system.js"));
});

describe("ui/menu/menu-bar-image-layer-menus.js", () => {
  it("buildImageMenu includes adjustments and cropbysel without aiF", () => {
    const imageMenu = buildImageMenu();
    assert.equal(imageMenu.name, "topMenu.image");
    assert.equal(imageMenu.items.length, imageMenu.menuActions.length);
    const cropAction = imageMenu.menuActions.find(
      (action) => action.payload && action.payload.actionKind === "cropbysel"
    );
    assert.ok(cropAction);
    assert.equal("aiF" in cropAction.payload, false);
  });

  it("Image > Mode lists colour modes and bit depths, with only RGB/8bpc live", () => {
    const imageMenu = buildImageMenu();
    const modeRowIndex = imageMenu.items.findIndex((item) => item.name === "imageModeMenuTitle");
    assert.equal(modeRowIndex, 0);
    const modeRow = imageMenu.items[modeRowIndex];
    const modeActions = imageMenu.menuActions[modeRowIndex];

    // items and menuActions are index-parallel, and that holds inside `sub` too.
    assert.equal(modeRow.sub.length, modeActions.sub.length);
    assert.deepEqual(
      modeRow.sub.map((item) => item.name),
      [
        "imageMode.bitmap",
        "imageMode.greyscale",
        "imageMode.indexedColour",
        "imageMode.rgbColour",
        "imageMode.cmykColour",
        "imageMode.labColour",
        "imageMode.multichannel",
        "imageMode.bitDepth8",
        "imageMode.bitDepth16",
        "imageMode.bitDepth32",
        "imageMode.colourTable",
      ]
    );

    // Only the rows naming where the document already is are selectable, since
    // picking those needs no conversion engine. Everything else is disabled
    // until there is one.
    const rgbDoc = { colorMode: ColorMode.rgb, bitDepth: 8 };
    for (const item of modeRow.sub) {
      const state = item.resolveRowState(rgbDoc);
      const isCurrent = item.name === "imageMode.rgbColour" || item.name === "imageMode.bitDepth8";
      assert.equal(state.checked === true, isCurrent, item.name);
      assert.equal(state.enabled === true, isCurrent, item.name);
    }
    // The palette editor is neither a mode nor a depth, so it never ticks.
    const colourTable = modeRow.sub.find((item) => item.name === "imageMode.colourTable");
    assert.equal(colourTable.resolveRowState(rgbDoc).checked, false);
    assert.equal(colourTable.resolveRowState(rgbDoc).enabled, false);
    assert.equal(modeRow.sub[3].resolveRowState(null).checked, false);

    // A depth row opens up once the GPU can render into a float attachment.
    // Without one the document would composite on the CPU, whose mask path is
    // still byte-only, so the row has to stay out of reach.
    const depthRow = modeRow.sub.find((item) => item.name === "imageMode.bitDepth32");
    const originalSupports = LayerSystem.supportsBitDepth;
    try {
      LayerSystem.supportsBitDepth = () => true;
      assert.equal(depthRow.resolveRowState(rgbDoc).enabled, true, "selectable once supported");
      assert.equal(depthRow.resolveRowState(rgbDoc).checked, false, "but not the current depth");
      LayerSystem.supportsBitDepth = () => false;
      assert.equal(depthRow.resolveRowState(rgbDoc).enabled, false, "greyed without float support");
    } finally {
      LayerSystem.supportsBitDepth = originalSupports;
    }

    // The tick follows the document rather than being hardcoded, which is what
    // lets a converted document report itself once conversion exists.
    const labDoc = { colorMode: ColorMode.lab, bitDepth: 32 };
    const checkedForLabDoc = modeRow.sub
      .filter((item) => item.resolveRowState(labDoc).checked === true)
      .map((item) => item.name);
    assert.deepEqual(checkedForLabDoc, ["imageMode.labColour", "imageMode.bitDepth32"]);
    assert.equal(
      modeRow.sub.find((item) => item.name === "imageMode.rgbColour").resolveRowState(labDoc).enabled,
      false,
      "a mode the document is not in stays unselectable",
    );

    // The macOS menu drops any row without a dispatch path or a submenu, so a
    // row missing its action would silently vanish from the native menu bar.
    for (const action of modeActions.sub) {
      assert.ok(action.appEventType, "every Mode row needs an action to render natively");
    }
  });

  it("Layer > New offers via-copy and via-cut, each wired to its own action", () => {
    const layerMenu = buildLayerMenu();
    const newRowIndex = layerMenu.items.findIndex((item) => item.name === "clipboard.new");
    const newRow = layerMenu.items[newRowIndex];
    const newActions = layerMenu.menuActions[newRowIndex];

    // items and menuActions are index-parallel, and that holds inside `sub` too:
    // a row added to one array without the other silently mis-fires every row below it.
    assert.equal(newRow.sub.length, newActions.sub.length);
    assert.deepEqual(
      newRow.sub.map((item) => item.name),
      ["topMenu.layer", "topMenu.folder", "layer.layerViaCopy", "layer.layerViaCut"]
    );
    assert.deepEqual(
      newActions.sub.map((action) => action.payload.actionKind),
      ["newLayer", "newFolder", "newLayerViaCopy", "newLayerViaCut"]
    );
  });

  it("Layer via Cut needs a selection, and takes Shift with the via-copy shortcut", () => {
    const layerMenu = buildLayerMenu();
    const newRow = layerMenu.items.find((item) => item.name === "clipboard.new");
    const viaCopy = newRow.sub.find((item) => item.name === "layer.layerViaCopy");
    const viaCut = newRow.sub.find((item) => item.name === "layer.layerViaCut");

    // Via Copy falls back to duplicating the layer when nothing is selected, so it
    // stays enabled; Via Cut has no such fallback and is gated on a selection.
    assert.equal(viaCopy.resolveRowState({ selectedLayerIndices: [0], selectionMask: null }).enabled, true);
    assert.equal(viaCut.resolveRowState({ selectedLayerIndices: [0], selectionMask: null }).enabled, false);
    assert.equal(viaCut.resolveRowState({ selectedLayerIndices: [0], selectionMask: {} }).enabled, true);
    assert.equal(viaCut.shortcut.length, viaCopy.shortcut.length + 1);
  });

  it("buildLayerMenu includes Smart Object stack-mode stats submenu", () => {
    const layerMenu = buildLayerMenu();
    assert.equal(layerMenu.name, "topMenu.layer");
    assert.equal(layerMenu.items.length, layerMenu.menuActions.length);
    const smartObject = layerMenu.items.find((item) => item.name === "Smart Object");
    assert.ok(smartObject);
    assert.ok(smartObject.sub);
    const stackMode = smartObject.sub.find((item) => item.name === "layer.smartObject.stackMode");
    assert.equal(stackMode.sub.length, 9);
  });
});
