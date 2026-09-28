/**
 * Pixel storage at 8, 16, or 32 bits per channel, and conversion between them.
 *
 * Every buffer is packed RGBA with four samples per pixel whatever the depth,
 * so `buffer.length >>> 2` is the pixel count in all three cases and only the
 * element type changes. What a sample *means* does not carry across depths:
 *
 * - **8-bit** — `Uint8Array`, 0..255, sRGB-encoded.
 * - **16-bit** — `Uint16Array`, 0..65535, sRGB-encoded. This is what a 16-bit
 *   PSD stores, confirmed against real files.
 * - **32-bit** — `Float32Array`, linear light, 0..1 for the displayable range
 *   and **deliberately unbounded above it**. Carrying linear values is the
 *   whole point of 32-bit mode: it is what lets highlights survive past white
 *   instead of clipping, and it is what PSD and EXR both store.
 *
 * So converting to or from 32-bit crosses a transfer curve as well as a scale,
 * while 8 ↔ 16 is a pure rescale. Alpha never crosses the curve — it is linear
 * coverage at every depth, and gamma-encoding it would distort compositing.
 */

import { allocBuffer } from "./buffer-utils.js";
import { linearToSrgb, srgbToLinear } from "./color-math.js";

/** Samples per pixel in every buffer this module allocates. */
const SAMPLES_PER_PIXEL = 4;

/** Largest sample value at each integer depth. */
const MAX_SAMPLE = { 8: 255, 16: 65535 };

/**
 * The exact 8 ↔ 16 scale: 65535 / 255. Multiplying by 256 and truncating — or
 * reading only the high byte — leaves midtones sitting a level dark.
 */
const SCALE_8_TO_16 = 257;

/** @param {number} bitDepth 8, 16, or 32 */
export function isSupportedBitDepth(bitDepth) {
  return bitDepth === 8 || bitDepth === 16 || bitDepth === 32;
}

/** Bytes one sample occupies at `bitDepth`. */
export function bytesPerSample(bitDepth) {
  return bitDepth >>> 3;
}

/** Bytes one RGBA pixel occupies at `bitDepth`. */
export function bytesPerPixel(bitDepth) {
  return SAMPLES_PER_PIXEL * bytesPerSample(bitDepth);
}

/**
 * The typed-array constructor storing samples at `bitDepth`.
 * @returns {Uint8ArrayConstructor|Uint16ArrayConstructor|Float32ArrayConstructor}
 */
export function pixelArrayType(bitDepth) {
  if (bitDepth === 8) return Uint8Array;
  if (bitDepth === 16) return Uint16Array;
  if (bitDepth === 32) return Float32Array;
  throw new Error("unsupported bit depth: " + bitDepth);
}

/** The depth a buffer is holding, from its element type. */
export function bitDepthOfBuffer(pixelBuffer) {
  if (pixelBuffer instanceof Float32Array) return 32;
  if (pixelBuffer instanceof Uint16Array) return 16;
  return 8;
}

/**
 * A zeroed RGBA buffer for `pixelCount` pixels at `bitDepth`.
 *
 * Allocated through {@link allocBuffer} so an out-of-memory failure is reported
 * the same way it is everywhere else, then viewed at the right element type.
 */
export function allocPixelBuffer(pixelCount, bitDepth) {
  const ArrayType = pixelArrayType(bitDepth);
  if (bitDepth === 8) return allocBuffer(pixelCount * SAMPLES_PER_PIXEL);
  const bytes = allocBuffer(pixelCount * bytesPerPixel(bitDepth), true);
  return new ArrayType(bytes.buffer);
}

/**
 * `pixelBuffer` converted to `toDepth`, or the buffer itself when it is already
 * at that depth. RGB samples cross the sRGB transfer curve when either side is
 * 32-bit; alpha only ever rescales.
 */
export function convertPixelBuffer(pixelBuffer, toDepth) {
  const fromDepth = bitDepthOfBuffer(pixelBuffer);
  if (fromDepth === toDepth) return pixelBuffer;
  const sampleCount = pixelBuffer.length;
  const converted = allocPixelBuffer(sampleCount / SAMPLES_PER_PIXEL, toDepth);
  for (let i = 0; i < sampleCount; i++) {
    const isAlpha = (i & 3) === 3;
    converted[i] = isAlpha
      ? rescaleAlpha(pixelBuffer[i], fromDepth, toDepth)
      : convertColorSample(pixelBuffer[i], fromDepth, toDepth);
  }
  return converted;
}

/**
 * One colour sample moved between depths.
 *
 * Going to 32-bit decodes to linear and keeps going past 1.0 untouched; coming
 * back from it re-encodes and clamps, because an integer depth has no room for
 * the range above white.
 */
export function convertColorSample(sample, fromDepth, toDepth) {
  if (fromDepth === toDepth) return sample;
  if (fromDepth === 32) {
    const encoded = sample > 0 ? (sample >= 1 ? 1 : linearToSrgb(sample)) : 0;
    return Math.round(encoded * MAX_SAMPLE[toDepth]);
  }
  if (toDepth === 32) return srgbToLinear(sample / MAX_SAMPLE[fromDepth]);
  return fromDepth === 8
    ? sample * SCALE_8_TO_16
    : Math.round(sample / SCALE_8_TO_16);
}

/**
 * Copy a rectangular region between two buffers of the same depth.
 *
 * `copyPixels` in `pixel-ops.js` moves one pixel as one 32-bit word, which is
 * only a pixel at 8-bit; here a row is copied as samples, so it holds at any
 * depth. Callers keep using that one for 8-bit, where word-at-a-time is faster.
 */
export function copyPixelRegion(srcBuffer, srcRect, dstBuffer, dstRect, clipRect) {
  const region = clipRect == null ? srcRect.intersect(dstRect) : srcRect.intersect(dstRect).intersect(clipRect);
  if (region.width <= 0 || region.height <= 0) return;
  const srcOffX = Math.max(0, region.x - srcRect.x);
  const srcOffY = Math.max(0, region.y - srcRect.y);
  const dstOffX = Math.max(0, region.x - dstRect.x);
  const dstOffY = Math.max(0, region.y - dstRect.y);
  const rowSamples = region.width * SAMPLES_PER_PIXEL;
  for (let row = 0; row < region.height; row++) {
    const srcStart = ((srcOffY + row) * srcRect.width + srcOffX) * SAMPLES_PER_PIXEL;
    const dstStart = ((dstOffY + row) * dstRect.width + dstOffX) * SAMPLES_PER_PIXEL;
    dstBuffer.set(srcBuffer.subarray(srcStart, srcStart + rowSamples), dstStart);
  }
}

/** Alpha is linear coverage at every depth, so it only ever changes scale. */
export function rescaleAlpha(sample, fromDepth, toDepth) {
  if (fromDepth === toDepth) return sample;
  if (fromDepth === 32) {
    const clamped = sample > 0 ? (sample >= 1 ? 1 : sample) : 0;
    return Math.round(clamped * MAX_SAMPLE[toDepth]);
  }
  if (toDepth === 32) return sample / MAX_SAMPLE[fromDepth];
  return fromDepth === 8
    ? sample * SCALE_8_TO_16
    : Math.round(sample / SCALE_8_TO_16);
}
