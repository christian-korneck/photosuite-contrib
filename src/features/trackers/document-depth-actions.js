/**
 * Image ▸ Mode bit-depth conversion, attached onto
 * LayerEffectsTracker.actionHandlers.
 *
 * Widening is lossless, narrowing is not: coming down from 32-bit discards
 * everything above white along with the precision the wider samples carried.
 * Undo therefore cannot re-convert, it has to restore what was there — so the
 * history entry keeps the layer buffers themselves.
 *
 * Keeping them costs nothing to make. `Document.convertBitDepth` *replaces*
 * each layer's buffer with a newly allocated one rather than writing through
 * the old, so the old arrays are already unreferenced by the time the entry
 * stores them. The memory is real, but no copy is taken.
 */
import { LayerEffectsTracker } from "./layer-effects-tracker.js";
import { commitHistoryAndRedo, createHistoryEntry } from "./layer-effects-action-helpers.js";
import { ColorMode } from "../../document/model/document.js";

const actionHandlers = LayerEffectsTracker.actionHandlers;
const undoHandlers = LayerEffectsTracker.undoHandlers;
const redoHandlers = LayerEffectsTracker.redoHandlers;

/** Action kind the Image ▸ Mode rows dispatch. */
export const CONVERT_MODE_ACTION = "convertMode";

/** Every layer's current pixel buffer, indexed the way `doc.layers` is. */
function captureLayerBuffers(doc) {
  const buffers = [];
  for (let layerIdx = 0; layerIdx < doc.layers.length; layerIdx++) {
    buffers.push(doc.layers[layerIdx].buffer);
  }
  return buffers;
}

/** Put captured buffers back and drop anything derived from the other depth. */
function restoreLayerBuffers(doc, buffers, bitDepth) {
  for (let layerIdx = 0; layerIdx < doc.layers.length && layerIdx < buffers.length; layerIdx++) {
    const layer = doc.layers[layerIdx];
    layer.buffer = buffers[layerIdx];
    layer.renderCache.dispose();
    layer.renderCache.needsRebuild = true;
    layer.renderCache.dirty = true;
    // The disposed cache has no texture, and only a dirty layer gets a new one.
    if (layer.markDirty) layer.markDirty();
  }
  doc.bitDepth = bitDepth;
  doc.buffer = null;
  if (doc.glTexture) {
    doc.glTexture.delete();
    doc.glTexture = null;
  }
  // Same reason as the conversion itself: an undone document has to be marked
  // dirty or `composite` reallocates the target and never draws into it.
  if (doc.markDirty) doc.markDirty();
  doc.needsComposite = true;
  doc.stateChanged = true;
}

function handleConvertMode(event, dispatcher, doc) {
  const targetDepth = event.targetDepth;
  const targetMode = event.targetMode;
  const changesDepth = targetDepth != null && targetDepth !== doc.bitDepth;
  // Greyscale is the only conversion with an engine behind it; the menu greys
  // the rest out, and anything that gets here anyway is ignored rather than
  // throwing out of a menu click.
  const changesMode = targetMode === ColorMode.greyscale && targetMode !== doc.colorMode;
  if (!changesDepth && !changesMode) return;

  const historyEntry = createHistoryEntry("dialogs.convertMode", this, {
    actionKind: CONVERT_MODE_ACTION,
    bitDepthBefore: doc.bitDepth,
    bitDepthAfter: changesDepth ? targetDepth : doc.bitDepth,
    colorModeBefore: doc.colorMode,
    colorModeAfter: changesMode ? targetMode : doc.colorMode,
    layerBuffersBefore: captureLayerBuffers(doc),
  });
  commitHistoryAndRedo(this, doc, historyEntry);
}

function undoConvertMode(historySnapshot, doc) {
  doc.colorMode = historySnapshot.colorModeBefore;
  restoreLayerBuffers(doc, historySnapshot.layerBuffersBefore, historySnapshot.bitDepthBefore);
}

function redoConvertMode(historySnapshot, doc) {
  doc.convertBitDepth(historySnapshot.bitDepthAfter);
  if (historySnapshot.colorModeAfter !== doc.colorMode) {
    doc.convertColorMode(historySnapshot.colorModeAfter);
  }
}

actionHandlers[CONVERT_MODE_ACTION] = handleConvertMode;
undoHandlers[CONVERT_MODE_ACTION] = undoConvertMode;
redoHandlers[CONVERT_MODE_ACTION] = redoConvertMode;
