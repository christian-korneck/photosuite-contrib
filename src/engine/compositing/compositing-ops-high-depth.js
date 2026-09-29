/**
 * Compositing for 16- and 32-bit documents.
 *
 * The 8-bit pipeline in `compositing-ops.js` packs pixels into a `Uint32Array`
 * and leans on 256-entry lookup tables, neither of which has a wider-depth
 * equivalent: a 16-bit table would need 65536² entries and a float one has no
 * finite domain at all. What it does *not* do is byte-bound arithmetic — it
 * normalises to 0..1, runs the shared blend functions, and only packs back to
 * bytes at the end. This module keeps that algebra exactly and changes what
 * happens at the two ends, so both depths blend identically and the 8-bit fast
 * paths stay untouched.
 *
 * At 32-bit nothing is clamped to 1.0 on the way out. Samples are linear light
 * (see `pixel-depth.js`) and a highlight above white is real data, not an
 * error; clamping here is what would destroy it. Alpha is still coverage, so it
 * is clamped to 0..1 at every depth.
 */

import {
  BLEND_FUNCTIONS,
  FILL_OPACITY_BLEND_MODES,
  NON_SEPARABLE_BLEND_MODES,
  SEPARABLE_BLEND_MODES,
  applyLayerMask,
} from "./compositing-ops.js";
import { bitDepthOfBuffer } from "./pixel-depth.js";

/** Largest storable sample per depth; 32-bit is unbounded, so it has no entry. */
const SAMPLE_CEILING = { 8: 255, 16: 65535 };

/**
 * Blend functions replaced at 32-bit.
 *
 * Most of the shared functions are already meaningful past white — multiply,
 * darken, lighten and difference all carry straight over — and the ones built
 * on inverse-multiply or a division by `1 - x` (screen, colour dodge, colour
 * burn) are only defined on 0..1, so they keep whatever bound they have rather
 * than producing nonsense. Linear dodge is the one that is plain addition and
 * *is* capped: `min(1, a + b)`, because the 8-bit path packs its result into a
 * byte lane. In float there is no such lane, and capping is exactly what stops
 * two bright sources accumulating into a highlight.
 *
 * Only 32-bit gets these. A 16-bit sample cannot exceed 1.0 in the first place,
 * so clamping there is correct rather than lossy.
 */
const HDR_BLEND_FUNCTIONS = {
  "lddg": function linearDodgeHdr(srcCh, dstCh, blendWeight) {
    return srcCh * blendWeight + dstCh;
  },
};

/**
 * How samples at `bitDepth` map to and from the normalised 0..1 the blend
 * functions work in.
 * @returns {{ toUnit: number, fromUnit: number, ceiling: number }} `ceiling` is
 * `Infinity` for float, which is what leaves values above white intact.
 */
function unitScaleFor(bitDepth) {
  const ceiling = SAMPLE_CEILING[bitDepth];
  if (ceiling == null) return { toUnit: 1, fromUnit: 1, ceiling: Infinity };
  return { toUnit: 1 / ceiling, fromUnit: ceiling, ceiling: ceiling };
}

/** A normalised sample stored back at `scale`'s depth: rounded and clamped for
 * an integer depth, written through untouched for float. */
function storeSample(unitValue, scale) {
  if (scale.ceiling === Infinity) return unitValue > 0 ? unitValue : 0;
  const scaled = Math.round(unitValue * scale.fromUnit);
  if (!(scaled > 0)) return 0;
  return scaled > scale.ceiling ? scale.ceiling : scaled;
}

/** Alpha is coverage, so it clamps to fully opaque at every depth. */
function storeAlpha(unitAlpha, scale) {
  const clamped = unitAlpha > 0 ? (unitAlpha > 1 ? 1 : unitAlpha) : 0;
  return scale.ceiling === Infinity ? clamped : Math.round(clamped * scale.fromUnit);
}

/**
 * Blend `sourceRgba` over `destRgba` at 16- or 32-bit, mirroring
 * {@link composite} in `compositing-ops.js`.
 *
 * Both buffers must be at the same depth; callers convert first.
 */
export function compositeHighDepth(
  mode, sourceRgba, sourceRect, destRgba, destRect, clipRect, opacity, styleParams,
) {
  if (styleParams == null) {
    styleParams = { fill: 1, blendIfTable: null, style: false, preserveDestAlpha: false };
  }
  const sourceDepth = bitDepthOfBuffer(sourceRgba);
  const destDepth = bitDepthOfBuffer(destRgba);
  if (sourceDepth !== destDepth) {
    throw new Error("compositeHighDepth: depth mismatch " + sourceDepth + " over " + destDepth);
  }
  // Same rule the 8-bit entry point applies: for every mode except the ones
  // that read fill separately, fill collapses into plain opacity.
  let effectiveOpacity = opacity;
  let fillOpacity = styleParams.fill;
  let isStyleLayer = styleParams.style;
  if (FILL_OPACITY_BLEND_MODES.indexOf(mode) === -1) {
    effectiveOpacity = opacity * styleParams.fill;
    fillOpacity = 1;
    isStyleLayer = false;
  }

  const blendFn = (destDepth === 32 ? HDR_BLEND_FUNCTIONS[mode] : null) || BLEND_FUNCTIONS[mode + "F"];
  if (blendFn == null) return;
  const region = intersectRegion(sourceRect, destRect, clipRect);
  if (region.width <= 0 || region.height <= 0) return;
  const scale = unitScaleFor(destDepth);
  const params = {
    blendFn: blendFn,
    opacity: effectiveOpacity,
    fillOpacity: fillOpacity,
    isStyleLayer: isStyleLayer,
    blendIfTable: styleParams.blendIfTable,
    preserveDestAlpha: styleParams.preserveDestAlpha ? 1 : 0,
    scale: scale,
  };

  if (SEPARABLE_BLEND_MODES.indexOf(mode) !== -1) {
    blendSeparableRegion(sourceRgba, destRgba, region, params);
  } else if (NON_SEPARABLE_BLEND_MODES.indexOf(mode) !== -1) {
    blendNonSeparableRegion(sourceRgba, destRgba, region, params);
  }
}

function intersectRegion(sourceRect, destRect, clipRect) {
  const intersectRect = sourceRect.intersect(destRect).intersect(clipRect);
  return {
    srcOffX: Math.max(0, intersectRect.x - sourceRect.x),
    dstOffX: Math.max(0, intersectRect.x - destRect.x),
    srcOffY: Math.max(0, intersectRect.y - sourceRect.y),
    dstOffY: Math.max(0, intersectRect.y - destRect.y),
    width: intersectRect.width,
    height: intersectRect.height,
    srcStride: sourceRect.width,
    dstStride: destRect.width,
  };
}

/** Per-channel blend modes — normal, multiply, screen, overlay and the rest. */
function blendNonSeparableRegion(sourceRgba, destRgba, region, params) {
  const { blendFn, opacity, fillOpacity, isStyleLayer, blendIfTable, preserveDestAlpha, scale } = params;
  const toUnit = scale.toUnit;
  for (let rowIdx = 0; rowIdx < region.height; rowIdx++) {
    let srcIdx = ((region.srcOffY + rowIdx) * region.srcStride + region.srcOffX) * 4;
    let dstIdx = ((region.dstOffY + rowIdx) * region.dstStride + region.dstOffX) * 4;
    for (let col = 0; col < region.width; col++, srcIdx += 4, dstIdx += 4) {
      const srcAlphaUnit = sourceRgba[srcIdx + 3] * toUnit;
      if (srcAlphaUnit === 0) continue;
      const srcR = sourceRgba[srcIdx] * toUnit;
      const srcG = sourceRgba[srcIdx + 1] * toUnit;
      const srcB = sourceRgba[srcIdx + 2] * toUnit;
      const dstR = destRgba[dstIdx] * toUnit;
      const dstG = destRgba[dstIdx + 1] * toUnit;
      const dstB = destRgba[dstIdx + 2] * toUnit;

      let srcAlphaEff = opacity;
      let dstAlphaUnit = 1;
      if (preserveDestAlpha === 0) {
        srcAlphaEff = srcAlphaUnit * opacity;
        dstAlphaUnit = destRgba[dstIdx + 3] * toUnit;
      }
      if (blendIfTable) {
        srcAlphaEff *= applyLayerMask(srcR, srcG, srcB, dstR, dstG, dstB, dstAlphaUnit, blendIfTable);
      }
      const outAlphaUnit = srcAlphaEff + dstAlphaUnit * (1 - srcAlphaEff);
      // The 8-bit separable loop divides by this without a guard and relies on
      // the packing to swallow the infinity; a float buffer would keep it.
      const unmultiply = outAlphaUnit === 0 ? 0 : 1 / outAlphaUnit;
      const styleAlpha = isStyleLayer ? 1 : srcAlphaEff;
      const blendWeight = (1 + srcAlphaEff - styleAlpha) * fillOpacity;
      const srcShare = (1 - dstAlphaUnit) * srcAlphaEff;
      const dstShare = (1 - styleAlpha) * dstAlphaUnit;
      const blendShare = styleAlpha * dstAlphaUnit;

      destRgba[dstIdx] = storeSample(
        (srcShare * srcR + dstShare * dstR + blendShare * blendFn(srcR, dstR, blendWeight)) * unmultiply, scale);
      destRgba[dstIdx + 1] = storeSample(
        (srcShare * srcG + dstShare * dstG + blendShare * blendFn(srcG, dstG, blendWeight)) * unmultiply, scale);
      destRgba[dstIdx + 2] = storeSample(
        (srcShare * srcB + dstShare * dstB + blendShare * blendFn(srcB, dstB, blendWeight)) * unmultiply, scale);
      if (preserveDestAlpha === 0) {
        const fillAlpha = srcAlphaEff * fillOpacity;
        destRgba[dstIdx + 3] = storeAlpha(fillAlpha + dstAlphaUnit * (1 - fillAlpha), scale);
      }
    }
  }
}

/** Whole-colour blend modes — hue, saturation, colour, luminosity, darker/lighter colour. */
function blendSeparableRegion(sourceRgba, destRgba, region, params) {
  const { blendFn, opacity, blendIfTable, preserveDestAlpha, scale } = params;
  const toUnit = scale.toUnit;
  const srcRgb = { h: 0, l: 0, O: 0 };
  const dstRgb = { h: 0, l: 0, O: 0 };
  const outRgb = { h: 0, l: 0, O: 0 };
  for (let rowIdx = 0; rowIdx < region.height; rowIdx++) {
    let srcIdx = ((region.srcOffY + rowIdx) * region.srcStride + region.srcOffX) * 4;
    let dstIdx = ((region.dstOffY + rowIdx) * region.dstStride + region.dstOffX) * 4;
    for (let col = 0; col < region.width; col++, srcIdx += 4, dstIdx += 4) {
      const srcR = sourceRgba[srcIdx] * toUnit;
      const srcG = sourceRgba[srcIdx + 1] * toUnit;
      const srcB = sourceRgba[srcIdx + 2] * toUnit;
      const dstR = destRgba[dstIdx] * toUnit;
      const dstG = destRgba[dstIdx + 1] * toUnit;
      const dstB = destRgba[dstIdx + 2] * toUnit;

      let srcAlphaEff = opacity;
      let dstAlphaUnit = 1;
      if (preserveDestAlpha === 0) {
        srcAlphaEff = sourceRgba[srcIdx + 3] * toUnit * opacity;
        dstAlphaUnit = destRgba[dstIdx + 3] * toUnit;
      }
      if (blendIfTable) {
        srcAlphaEff *= applyLayerMask(srcR, srcG, srcB, dstR, dstG, dstB, dstAlphaUnit, blendIfTable);
      }
      const dstContrib = dstAlphaUnit * (1 - srcAlphaEff);
      const outAlphaUnit = srcAlphaEff + dstContrib;
      const unmultiply = outAlphaUnit === 0 ? 0 : 1 / outAlphaUnit;

      // `h`/`l`/`O` take the buffer's first, second and third channel in that
      // order. The 8-bit loop reads them through a little-endian `Uint32` view,
      // so its own `srcB`/`srcG`/`srcR` names run opposite to memory — these
      // modes weight channels by luminance, so the order has to match it.
      srcRgb.h = srcR; srcRgb.l = srcG; srcRgb.O = srcB;
      dstRgb.h = dstR; dstRgb.l = dstG; dstRgb.O = dstB;
      blendFn(srcRgb, dstRgb, outRgb);

      destRgba[dstIdx] = storeSample(
        (((1 - dstAlphaUnit) * srcR + dstAlphaUnit * outRgb.h) * srcAlphaEff + dstR * dstContrib) * unmultiply, scale);
      destRgba[dstIdx + 1] = storeSample(
        (((1 - dstAlphaUnit) * srcG + dstAlphaUnit * outRgb.l) * srcAlphaEff + dstG * dstContrib) * unmultiply, scale);
      destRgba[dstIdx + 2] = storeSample(
        (((1 - dstAlphaUnit) * srcB + dstAlphaUnit * outRgb.O) * srcAlphaEff + dstB * dstContrib) * unmultiply, scale);
      if (preserveDestAlpha === 0) destRgba[dstIdx + 3] = storeAlpha(outAlphaUnit, scale);
    }
  }
}
