/**
 * HDR and scientific float codecs: EXR and FITS.
 * Wired in `file-format-registry.js`.
 */

import { Rect } from "../../../core/math/rect.js";
import { BinaryUtils } from "../../../core/binary/binary-utils.js";
import { allocBuffer } from "../../../engine/compositing/buffer-utils.js";
import { linearToSrgb } from "../../../engine/compositing/color-math.js";
import { LayerSystem } from "../../../engine/layer-system.js";

/* global EXRLoader */

const FITS_HEADER_CARD_BYTES = 80;
const FITS_HEADER_MAX_CARDS = 306;
const FITS_DATA_BLOCK_BYTES = 2880;

/** Maps one linear HDR channel sample to an 8-bit sRGB byte. */
function linearChannelToByte(linearChannel) {
  return ~~(0.5 + linearToSrgb(Math.max(0, Math.min(1, linearChannel))) * 255);
}

function flipExrFloatRowsToRgba(exrData) {
  var width = exrData.width;
  var height = exrData.height;
  var rgbaBuffer = allocBuffer(width * height * 4);
  for (var rowIdx = 0; rowIdx < height; rowIdx++) {
    for (var colIdx = 0; colIdx < width; colIdx++) {
      var destOffset = (rowIdx * width + colIdx) * 4;
      var srcOffset = ((height - rowIdx - 1) * width + colIdx) * 4;
      rgbaBuffer[destOffset] = linearChannelToByte(exrData.data[srcOffset + 0]);
      rgbaBuffer[destOffset + 1] = linearChannelToByte(exrData.data[srcOffset + 1]);
      rgbaBuffer[destOffset + 2] = linearChannelToByte(exrData.data[srcOffset + 2]);
      rgbaBuffer[destOffset + 3] = linearChannelToByte(exrData.data[srcOffset + 3]);
    }
  }
  return { width: width, height: height, rgbaBuffer: rgbaBuffer };
}

function decodeExrDocument(buffer, doc) {
  var exrData = EXRLoader.parse(buffer);
  var rgbaResult = flipExrFloatRowsToRgba(exrData);
  return [{
    rect: new Rect(0, 0, rgbaResult.width, rgbaResult.height),
    data: rgbaResult.rgbaBuffer.buffer,
  }];
}

/** Reads FITS header cards until END; returns field map and byte offset to pixel data. */
function parseFitsHeader(bytes) {
  var headerOffset = 0;
  var headerFields = {};
  for (var cardIdx = 0; cardIdx < FITS_HEADER_MAX_CARDS; cardIdx++) {
    var keyword = BinaryUtils.readString(bytes, headerOffset, 8).trim();
    var value = BinaryUtils.readString(bytes, headerOffset + 9, 71).split("/")[0].trim();
    headerFields[keyword] = value;
    headerOffset += FITS_HEADER_CARD_BYTES;
    if (keyword === "END") {
      headerOffset = Math.ceil(headerOffset / FITS_DATA_BLOCK_BYTES) * FITS_DATA_BLOCK_BYTES;
      break;
    }
  }
  return { headerFields: headerFields, dataOffset: headerOffset };
}

function readFitsPixelValues(bytes, headerFields, dataOffset) {
  var width = parseInt(headerFields.NAXIS1);
  var height = parseInt(headerFields.NAXIS2);
  var pixelCount = width * height;
  var bitpix = parseInt(headerFields.BITPIX);
  var minValue = 1e9;
  var maxValue = -1e9;
  var pixelValues = new Float32Array(pixelCount);
  var floatView = new Float32Array(bytes.buffer, dataOffset, bytes.buffer.byteLength - dataOffset >>> 2);
  for (var pixelIdx = 0; pixelIdx < pixelCount; pixelIdx++) {
    var byteOffset32 = pixelIdx << 2;
    var byteOffset16 = pixelIdx << 1;
    if (bitpix === -32) {
      var swapByte = bytes[dataOffset + byteOffset32 + 0];
      bytes[dataOffset + byteOffset32 + 0] = bytes[dataOffset + byteOffset32 + 3];
      bytes[dataOffset + byteOffset32 + 3] = swapByte;
      swapByte = bytes[dataOffset + byteOffset32 + 1];
      bytes[dataOffset + byteOffset32 + 1] = bytes[dataOffset + byteOffset32 + 2];
      bytes[dataOffset + byteOffset32 + 2] = swapByte;
      pixelValues[pixelIdx] = floatView[pixelIdx];
    } else if (bitpix === 16) {
      pixelValues[pixelIdx] = BinaryUtils.readUint16LE(bytes, dataOffset + byteOffset16);
    } else throw bitpix;
    var sampleValue = pixelValues[pixelIdx];
    if (sampleValue < minValue) minValue = sampleValue;
    if (sampleValue > maxValue) maxValue = sampleValue;
  }
  return { width: width, height: height, pixelValues: pixelValues, maxValue: maxValue };
}

function fitsPixelsToRgba(pixelPayload, headerFields) {
  var width = pixelPayload.width;
  var height = pixelPayload.height;
  var pixelValues = pixelPayload.pixelValues;
  var pixelCount = width * height;
  var rgbaBuffer = allocBuffer(pixelCount * 4);
  var scaleFactor = 1 / pixelPayload.maxValue;
  for (var rowIdx = 0; rowIdx < height; rowIdx++) {
    for (var colIdx = 0; colIdx < width; colIdx++) {
      var pixelIdx = rowIdx * width + colIdx;
      var flippedPixelIdx = (height - rowIdx - 1) * width + colIdx;
      var rgbaOffset = flippedPixelIdx << 2;
      var normalizedValue = pixelValues[pixelIdx] * scaleFactor;
      rgbaBuffer[rgbaOffset] = rgbaBuffer[rgbaOffset + 1] = rgbaBuffer[rgbaOffset + 2] = 255 * normalizedValue;
      rgbaBuffer[rgbaOffset + 3] = 255;
    }
  }
  return {
    rect: new Rect(0, 0, width, height),
    data: rgbaBuffer,
    layerName: headerFields.OBJECT,
  };
}

function decodeFitsDocument(buffer) {
  var bytes = new Uint8Array(buffer);
  var header = parseFitsHeader(bytes);
  var pixelPayload = readFitsPixelValues(bytes, header.headerFields, header.dataOffset);
  return [fitsPixelsToRgba(pixelPayload, header.headerFields)];
}

/**
 * Read the Radiance header, returning the pixel dimensions and where the
 * scanlines start. The header is text lines, then a blank line, then a
 * resolution line; only the `-Y h +X w` orientation is produced in practice.
 */
function parseRadianceHeader(bytes) {
  if (bytes[0] !== 35 || bytes[1] !== 63) throw new Error("not a Radiance file");
  var offset = 0;
  var line = "";
  var sawBlankLine = false;
  while (offset < bytes.length) {
    var ch = bytes[offset++];
    if (ch !== 10) {
      line += String.fromCharCode(ch);
      continue;
    }
    if (sawBlankLine) {
      var resolution = line.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
      if (resolution == null) throw new Error("unsupported Radiance resolution line: " + line);
      return { width: parseInt(resolution[2]), height: parseInt(resolution[1]), dataOffset: offset };
    }
    if (line === "") sawBlankLine = true;
    line = "";
  }
  throw new Error("truncated Radiance header");
}

/**
 * Expand one adaptive-RLE scanline into `rgbeRow`, which holds the four
 * channels one after another rather than interleaved.
 *
 * @returns {number} offset after the scanline
 */
function readRadianceRleScanline(bytes, offset, width, rgbeRow) {
  for (var channel = 0; channel < 4; channel++) {
    var writeIdx = channel * width;
    var channelEnd = writeIdx + width;
    while (writeIdx < channelEnd) {
      var count = bytes[offset++];
      if (count > 128) {
        var repeated = bytes[offset++];
        count -= 128;
        for (var r = 0; r < count; r++) rgbeRow[writeIdx++] = repeated;
      } else {
        for (var c = 0; c < count; c++) rgbeRow[writeIdx++] = bytes[offset++];
      }
    }
  }
  return offset;
}

/** One RGBE quadruple as linear RGB, written into `outPixels` at `outIdx`. */
function writeRgbeAsLinear(outPixels, outIdx, red, green, blue, exponent) {
  if (exponent === 0) {
    outPixels[outIdx] = 0;
    outPixels[outIdx + 1] = 0;
    outPixels[outIdx + 2] = 0;
  } else {
    // Shared exponent, biased by 128, with the mantissa scaled out of 256.
    var scale = Math.pow(2, exponent - 136);
    outPixels[outIdx] = red * scale;
    outPixels[outIdx + 1] = green * scale;
    outPixels[outIdx + 2] = blue * scale;
  }
  outPixels[outIdx + 3] = 1;
}

/**
 * Decode a Radiance (.hdr / .pic) file into one linear float frame.
 *
 * Values are light rather than display levels, so they run past 1.0 and are
 * kept that way — the same convention 32-bit documents use.
 */
function decodeRadianceDocument(buffer) {
  var bytes = new Uint8Array(buffer);
  var header = parseRadianceHeader(bytes);
  var width = header.width;
  var height = header.height;
  var pixels = new Float32Array(width * height * 4);
  var rgbeRow = new Uint8Array(width * 4);
  var offset = header.dataOffset;

  for (var row = 0; row < height; row++) {
    var isRleRow = width >= 8 && width < 32768
      && bytes[offset] === 2 && bytes[offset + 1] === 2
      && ((bytes[offset + 2] << 8) | bytes[offset + 3]) === width;
    if (isRleRow) {
      offset = readRadianceRleScanline(bytes, offset + 4, width, rgbeRow);
      for (var col = 0; col < width; col++) {
        writeRgbeAsLinear(pixels, (row * width + col) * 4,
          rgbeRow[col], rgbeRow[width + col], rgbeRow[2 * width + col], rgbeRow[3 * width + col]);
      }
      continue;
    }
    for (var flatCol = 0; flatCol < width; flatCol++) {
      writeRgbeAsLinear(pixels, (row * width + flatCol) * 4,
        bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      offset += 4;
    }
  }

  // Keeping the linear floats needs a GPU that can composite them; without one
  // the file still opens, narrowed the way EXR already is.
  if (LayerSystem.supportsBitDepth(32)) {
    return [{ rect: new Rect(0, 0, width, height), data: pixels, bitDepth: 32 }];
  }
  var bytes = allocBuffer(width * height * 4);
  for (var i = 0; i < bytes.length; i += 4) {
    bytes[i] = linearChannelToByte(pixels[i]);
    bytes[i + 1] = linearChannelToByte(pixels[i + 1]);
    bytes[i + 2] = linearChannelToByte(pixels[i + 2]);
    bytes[i + 3] = 255;
  }
  return [{ rect: new Rect(0, 0, width, height), data: bytes.buffer }];
}

export const exrCodec = {};
exrCodec.decode = decodeExrDocument;

export const radianceCodec = {};
radianceCodec.decode = decodeRadianceDocument;

export const fitsCodec = {};
fitsCodec.decode = decodeFitsDocument;
