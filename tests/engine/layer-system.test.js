/**
 * Golden values for layer-system (compositing / WebGL runtime).
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import { installBrowserGlobals } from "../helpers/stub-browser-globals.js";
import { allocBuffer } from "../../src/engine/compositing/buffer-utils.js";

installBrowserGlobals();

let Rect;
let initLayerSystemGl;
let AdjustmentShaderType;
let defaultShapeStyleParams;

function stubWebGlCanvas() {
  document.createElement = (tag) => {
    if (tag === "canvas") {
      const gl = {
        createFramebuffer() {
          return {};
        },
        bindFramebuffer() {},
        disable() {},
        createBuffer() {
          return {};
        },
        bindBuffer() {},
        bufferData() {},
        enableVertexAttribArray() {},
        vertexAttribPointer() {},
        getParameter() {
          return 8192;
        },
        FRAGMENT_SHADER: 1,
        VERTEX_SHADER: 2,
        ARRAY_BUFFER: 3,
        STATIC_DRAW: 4,
        FLOAT: 5,
        FRAMEBUFFER: 6,
        BLEND: 19,
        DEPTH_TEST: 20,
      };
      return {
        getContext(type) {
          return type === "webgl" || type === "experimental-webgl" ? gl : null;
        },
      };
    }
    return { style: {} };
  };
}

/**
 * `initLayerSystemGl` keeps the first context it is given, so a test wanting a
 * different one has to clear the canvas that records it.
 */
function resetGlSingleton() {
  const layerSystem = initLayerSystemGl();
  layerSystem.offscreenCanvas = null;
  layerSystem.webglEnabled = false;
  layerSystem.glContextAvailable = false;
  layerSystem.isWebGl2 = false;
}

function createLayerSystem() {
  resetGlSingleton();
  stubWebGlCanvas();
  return initLayerSystemGl();
}

/**
 * Stub a canvas that also offers a "webgl2" context, granting only the
 * extensions in `grantedExtensions`.
 */
function stubWebGl2Canvas(grantedExtensions) {
  const gl = {
    createFramebuffer: () => ({}),
    bindFramebuffer() {},
    disable() {},
    createBuffer: () => ({}),
    bindBuffer() {},
    bufferData() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    getParameter: () => 8192,
    getExtension(name) {
      if (grantedExtensions.indexOf(name) === -1) return null;
      return name === "EXT_texture_norm16" ? { RGBA16_EXT: 0x805b } : {};
    },
    RGBA: 6408,
    RGBA32F: 34836,
    UNSIGNED_BYTE: 5121,
    UNSIGNED_SHORT: 5123,
    FLOAT: 5126,
    FRAGMENT_SHADER: 1,
    VERTEX_SHADER: 2,
    ARRAY_BUFFER: 3,
    STATIC_DRAW: 4,
    FRAMEBUFFER: 6,
    BLEND: 19,
    DEPTH_TEST: 20,
  };
  resetGlSingleton();
  document.createElement = (tag) => {
    if (tag === "canvas") {
      return { getContext: (type) => (type === "webgl2" ? gl : null) };
    }
    return { style: {} };
  };
  return initLayerSystemGl();
}

before(async () => {
  ({ Rect } = await import("../../src/core/math/rect.js"));
  ({ initLayerSystemGl, AdjustmentShaderType, defaultShapeStyleParams } = await import(
    "../../src/engine/layer-system.js"
  ));
});

describe("engine/layer-system.js", () => {
  it("the layer system enables WebGL when a context is available", () => {
    const ls = createLayerSystem();
    assert.equal(ls.webglEnabled, true);
    assert.equal(ls.glContextAvailable, true);
    assert.equal(typeof ls.RgbaTexture, "function");
    assert.equal(typeof ls.renderers.BlendShader, "function");
    assert.equal(Object.keys(ls.renderers.blendShaderBodies).length, 27);
    assert.equal(Object.keys(ls.shaderLib).length, 21);
    assert.equal(ls.filter.DEPTH_BEVEL, 3);
  });

  it("minifyGlsl collapses whitespace around punctuation", () => {
    const ls = createLayerSystem();
    assert.equal(ls.minifyGlsl("  foo  ;  bar  }  {  =  |  x  "), " foo ;bar}{=|x ");
  });

  it("rectToViewportCoords matches captured Float32 values", () => {
    const ls = createLayerSystem();
    const coords = ls.rectToViewportCoords(
      new Rect(10, 20, 30, 40),
      new Rect(0, 0, 100, 200),
    );
    assert.deepEqual(Array.from(coords), [
      0.10000000149011612, 0.10000000149011612, 0.30000001192092896, 0.20000000298023224,
    ]);
  });

  it("bindMainCanvas rejects scissorRect", () => {
    const ls = createLayerSystem();
    try {
      ls.bindMainCanvas(100, 100, new Rect(0, 0, 10, 10));
      assert.fail("expected throw");
    } catch (err) {
      assert.ok(err instanceof Error);
      assert.match(err.message, /scissor/);
    }
  });

  // The ids index LayerSystem.adjLayerShaders, and the adjustment engine names
  // them when it builds shader options — reordering them would silently swap
  // which shader program runs.
  it("AdjustmentShaderType ids match the adjLayerShaders order", () => {
    assert.deepEqual({ ...AdjustmentShaderType }, {
      LookupTable: 0,
      HueSat: 1,
      Vibrance: 2,
      SelectiveColor: 3,
      BlackWhite: 4,
      ColorMatrix: 5,
      ReplaceColor: 6,
      IccLut: 7,
    });
  });

  // 16- and 32-bit documents composite by rendering into a texture, so the
  // question is never "can this GPU hold the format" but "can it attach it to a
  // framebuffer" — which is an extension even under WebGL2.
  describe("bit-depth capability detection", () => {
    it("offers only 8-bit on a WebGL1 context", () => {
      const ls = createLayerSystem();
      assert.equal(ls.isWebGl2, false);
      assert.equal(ls.glCapabilities.webgl2, false);
      assert.deepEqual([8, 16, 32].map((d) => ls.supportsBitDepth(d)), [true, false, false]);
    });

    it("offers the wider depths when float attachments are renderable", () => {
      const ls = stubWebGl2Canvas(["EXT_color_buffer_float"]);
      assert.equal(ls.isWebGl2, true);
      assert.deepEqual([8, 16, 32].map((d) => ls.supportsBitDepth(d)), [true, true, true]);
    });

    it("keeps the wider depths off a WebGL2 context that cannot render float", () => {
      const ls = stubWebGl2Canvas([]);
      assert.equal(ls.isWebGl2, true);
      assert.deepEqual([8, 16, 32].map((d) => ls.supportsBitDepth(d)), [true, false, false]);
    });

    it("leaves 8-bit on WebGL1's unsized RGBA so the common path is unchanged", () => {
      const ls = createLayerSystem();
      const format = ls.textureFormatFor(8);
      assert.equal(format.internalFormat, format.format, "8-bit stays unsized");
      assert.equal(format.linearFilterable, true);
    });

    it("prefers a normalized RGBA16 attachment for 16-bit when it exists", () => {
      const withNorm16 = stubWebGl2Canvas(["EXT_color_buffer_float", "EXT_texture_norm16"]);
      const format = withNorm16.textureFormatFor(16);
      assert.equal(format.internalFormat, 0x805b, "uses the extension's RGBA16_EXT");
      assert.equal(format.type, 5123, "unsigned short samples");
    });

    it("falls back to RGBA32F for 16-bit, which carries the samples exactly", () => {
      // Deliberately not RGBA16F — an 11-bit mantissa cannot hold 16-bit values.
      const noNorm16 = stubWebGl2Canvas(["EXT_color_buffer_float"]);
      const format = noNorm16.textureFormatFor(16);
      assert.equal(format.internalFormat, 34836, "RGBA32F");
      assert.equal(format.type, 5126, "float samples");
    });

    it("drops float textures to nearest filtering without OES_texture_float_linear", () => {
      const noLinear = stubWebGl2Canvas(["EXT_color_buffer_float"]);
      assert.equal(noLinear.textureFormatFor(32).linearFilterable, false);
      const withLinear = stubWebGl2Canvas(["EXT_color_buffer_float", "OES_texture_float_linear"]);
      assert.equal(withLinear.textureFormatFor(32).linearFilterable, true);
    });
  });

  // The texture format follows the document's depth, but 8-bit must keep
  // issuing exactly the calls it always did — it is the path every existing
  // document takes.
  describe("depth-aware textures", () => {
    /** A WebGL2 stub that records every texImage2D / readPixels call. */
    function recordingLayerSystem(grantedExtensions) {
      const ls = stubWebGl2Canvas(grantedExtensions);
      const calls = { texImage2D: [], readPixels: [], texParameteri: [] };
      Object.assign(ls.renderCtx, {
        createTexture: () => ({}),
        bindTexture() {},
        texParameteri(target, name, value) { calls.texParameteri.push([name, value]); },
        texImage2D(...args) { calls.texImage2D.push(args); },
        readPixels(...args) { calls.readPixels.push(args); },
        bindFramebuffer() {},
        framebufferTexture2D() {},
        viewport() {},
        enable() {},
        scissor() {},
        TEXTURE_2D: 3553,
        TEXTURE_MIN_FILTER: 10241,
        TEXTURE_MAG_FILTER: 10240,
        TEXTURE_WRAP_S: 10242,
        TEXTURE_WRAP_T: 10243,
        CLAMP_TO_EDGE: 33071,
        NEAREST: 9728,
        LINEAR: 9729,
        COLOR_ATTACHMENT0: 36064,
        SCISSOR_TEST: 3089,
      });
      return { ls, calls };
    }

    it("allocates 8-bit textures with the unsized RGBA triple, as before", () => {
      const { ls, calls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      new ls.RgbaTexture(4, 4);
      const [, , internalFormat, , , , format, type] = calls.texImage2D[0];
      assert.equal(internalFormat, 6408, "internalFormat is RGBA");
      assert.equal(format, 6408);
      assert.equal(type, 5121, "UNSIGNED_BYTE");
    });

    it("allocates 32-bit textures as RGBA32F float", () => {
      const { ls, calls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      new ls.RgbaTexture(4, 4, false, 32);
      const [, , internalFormat, , , , format, type] = calls.texImage2D[0];
      assert.equal(internalFormat, 34836, "RGBA32F");
      assert.equal(format, 6408);
      assert.equal(type, 5126, "FLOAT");
    });

    it("reads a texture back in its own format, not always as bytes", () => {
      const { ls, calls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      const texture = new ls.RgbaTexture(2, 2, false, 32);
      texture.get(new Float32Array(16));
      const [, , , , format, type] = calls.readPixels[0];
      assert.equal(format, 6408);
      assert.equal(type, 5126, "reads floats back, not bytes");
    });

    it("refuses linear filtering on float textures the driver cannot filter", () => {
      const { ls, calls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      new ls.RgbaTexture(4, 4, true, 32);
      const minFilter = calls.texParameteri.find(([name]) => name === 10241);
      assert.equal(minFilter[1], 9728, "falls back to NEAREST without float linear filtering");
    });

    it("keeps linear filtering when the driver supports it", () => {
      const { ls, calls } = recordingLayerSystem([
        "EXT_color_buffer_float", "OES_texture_float_linear",
      ]);
      new ls.RgbaTexture(4, 4, true, 32);
      const minFilter = calls.texParameteri.find(([name]) => name === 10241);
      assert.equal(minFilter[1], 9729, "LINEAR");
    });

    it("counts wider textures as the memory they actually occupy", () => {
      const { ls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      const before = ls.textureMemoryCount;
      new ls.RgbaTexture(10, 10, false, 32);
      assert.equal(ls.textureMemoryCount - before, 10 * 10 * 16, "four float samples per pixel");
    });

    // `copyTexImage2D` allocates as well as copies, and accepts only a
    // restricted set of internal formats — a sized float one is not among them.
    // Using it on a float texture corrupts the blend destination, which shows
    // up as garbage exactly where one layer blends over another.
    // `copyTexImage2D` allocates as well as copies, and accepts only a
    // restricted set of internal formats — a sized float one is not among them.
    it("clones a float texture by copying into it, not by re-allocating", () => {
      const { ls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      const calls = { copyTexImage2D: 0, copyTexSubImage2D: 0 };
      ls.renderCtx.copyTexImage2D = () => { calls.copyTexImage2D++; };
      ls.renderCtx.copyTexSubImage2D = () => { calls.copyTexSubImage2D++; };

      new ls.RgbaTexture(4, 4, false, 32).clone();

      assert.equal(calls.copyTexImage2D, 0, "never re-allocates a float format");
      assert.equal(calls.copyTexSubImage2D, 1);
    });

    it("still clones 8-bit with the allocating copy, as it always did", () => {
      const { ls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      let allocatingCopies = 0;
      ls.renderCtx.copyTexImage2D = () => { allocatingCopies++; };
      ls.renderCtx.copyTexSubImage2D = () => {};

      new ls.RgbaTexture(4, 4).clone();

      assert.equal(allocatingCopies, 1);
    });

    // A caller holding bytes for a float texture must not have to convert its
    // whole buffer per draw — a brush dab should cost a dab. So the texture
    // conforms what it is given, and only for the region it uploads.
    it("conforms a byte buffer to its own format on upload", () => {
      const { ls, calls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      const floatTexture = new ls.RgbaTexture(2, 2, false, 32);
      calls.texImage2D.length = 0;

      floatTexture.set(new Uint8Array(16));

      const uploaded = calls.texImage2D[0][8];
      assert.ok(uploaded instanceof Float32Array, `uploaded a ${uploaded.constructor.name}`);
    });

    it("stages and converts only the dirty region, not the whole surface", () => {
      const { ls, calls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      calls.texSubImage2D = [];
      ls.renderCtx.texSubImage2D = (...args) => { calls.texSubImage2D.push(args); };
      const floatTexture = new ls.RgbaTexture(100, 100, false, 32);
      calls.texImage2D.length = 0;

      floatTexture.set(new Uint8Array(100 * 100 * 4), new Rect(0, 0, 2, 2));

      assert.equal(calls.texImage2D.length, 0, "a small dab does not re-upload the surface");
      const staged = calls.texSubImage2D[0][8];
      assert.ok(staged instanceof Float32Array, "staged region is converted");
      assert.equal(staged.length, 2 * 2 * 4, "and is only the dirty region");
    });

    it("leaves a buffer already at its own depth alone", () => {
      const { ls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      const floatTexture = new ls.RgbaTexture(2, 2, false, 32);
      const alreadyFloat = new Float32Array(16);
      assert.equal(floatTexture.conformPixels(alreadyFloat), alreadyFloat, "no needless copy");
    });

    it("clones a texture at its own depth rather than dropping to 8-bit", () => {
      const { ls } = recordingLayerSystem(["EXT_color_buffer_float"]);
      ls.renderCtx.copyTexImage2D = () => {};
      ls.renderCtx.copyTexSubImage2D = () => {};
      const clone = new ls.RgbaTexture(4, 4, false, 32).clone();
      assert.equal(clone.bitDepth, 32);
    });
  });

  // `mediump` guarantees only ~10 bits of mantissa, which cannot carry even a
  // 16-bit sample. The wider depths need `highp` — and a variant compiled at one
  // precision must never be handed to a document needing the other.
  describe("shader precision", () => {
    it("maps 8-bit to mediump and the wider depths to highp", () => {
      const ls = createLayerSystem();
      assert.equal(ls.precisionForBitDepth(8), "mediump");
      assert.equal(ls.precisionForBitDepth(16), "highp");
      assert.equal(ls.precisionForBitDepth(32), "highp");
    });

    it("leaves a mediump source byte-identical rather than rewriting it", () => {
      const ls = createLayerSystem();
      const source = "precision mediump float;\nvoid main(){}";
      assert.equal(ls.withShaderPrecision(source, "mediump"), source);
    });

    it("rewrites every precision declaration for highp", () => {
      const ls = createLayerSystem();
      const source = "precision mediump float;\nprecision  mediump   float ;\nvoid main(){}";
      const highp = ls.withShaderPrecision(source, "highp");
      assert.equal(highp.indexOf("mediump"), -1, "no mediump declaration survives");
      assert.equal(highp.match(/precision highp float;/g).length, 2);
    });

    it("defaults to mediump, so nothing changes until a document asks", () => {
      const ls = createLayerSystem();
      assert.equal(ls.shaderPrecision, "mediump");
    });

    it("keys cached programs by precision so variants cannot collide", () => {
      const ls = createLayerSystem();
      ls.renderers.singletonShaderCache = {};
      let built = 0;
      const build = () => ({ id: ++built });

      ls.shaderPrecision = "mediump";
      const mediumFirst = ls.renderers.getCachedShader("passthrough", build);
      const mediumAgain = ls.renderers.getCachedShader("passthrough", build);
      ls.shaderPrecision = "highp";
      const high = ls.renderers.getCachedShader("passthrough", build);
      ls.shaderPrecision = "mediump";

      assert.equal(mediumAgain, mediumFirst, "same precision reuses the program");
      assert.notEqual(high, mediumFirst, "a highp document gets its own program");
      assert.equal(built, 2);
    });
  });

  // The CPU compositor gives linear dodge a 32-bit variant that does not cap at
  // white; the shaders have to agree, or the same document blends differently
  // depending on which path runs.
  describe("unbounded blending at 32-bit", () => {
    it("caps linear dodge at white for the bounded depths", () => {
      const ls = createLayerSystem();
      assert.match(ls.renderers.blendShaderBodyFor("lddg", false), /min\(ONE3/);
      assert.match(ls.renderers.blendShaderBodyFor("lddg", 8), /min\(ONE3/);
    });

    it("drops the cap for a 32-bit document, so highlights accumulate", () => {
      const ls = createLayerSystem();
      const body = ls.renderers.blendShaderBodyFor("lddg", true);
      assert.equal(body.indexOf("min(ONE3"), -1, "no ceiling on an unbounded blend");
      assert.match(body, /a\s*\+\s*b/, "still an addition");
    });

    it("leaves the modes that are only defined on 0..1 alone", () => {
      const ls = createLayerSystem();
      // Screen is inverse-multiply; unbounding it produces nonsense, not range.
      assert.equal(
        ls.renderers.blendShaderBodyFor("scrn", true),
        ls.renderers.blendShaderBodyFor("scrn", false),
      );
    });

    it("keys the shader cache on it, so the two variants cannot collide", () => {
      const ls = createLayerSystem();
      ls.renderers.singletonShaderCache = {};
      let built = 0;
      const build = () => ({ id: ++built });

      ls.unboundedBlending = false;
      const bounded = ls.renderers.getCachedShader("blend", build);
      ls.unboundedBlending = true;
      const unbounded = ls.renderers.getCachedShader("blend", build);
      ls.unboundedBlending = false;

      assert.notEqual(unbounded, bounded);
      assert.equal(built, 2);
    });
  });

  // A shader that fails to build leaves a program that draws black. Without a
  // record of the failure nothing can tell that apart from a black document,
  // which is what the upcoming float-format variants need in order to fall back.
  describe("shader build failures", () => {
    /** A GL stub whose shader stages and link step each succeed or fail on demand. */
    function stubGlWithBuildResults(stagesCompile, programLinks) {
      return {
        FRAGMENT_SHADER: 1,
        VERTEX_SHADER: 2,
        COMPILE_STATUS: 10,
        LINK_STATUS: 11,
        createShader: () => ({}),
        shaderSource() {},
        compileShader() {},
        getShaderParameter: () => stagesCompile,
        getShaderInfoLog: () => "ERROR: no matching overload for highp",
        createProgram: () => ({}),
        attachShader() {},
        linkProgram() {},
        getProgramParameter: () => programLinks,
        getProgramInfoLog: () => "ERROR: could not link",
      };
    }

    /** Build one program against `gl`, returning it plus anything logged. */
    function buildProgramWith(ls, gl) {
      const originalCtx = ls.renderCtx;
      const originalConsoleError = console.error;
      const logged = [];
      console.error = (...args) => logged.push(args.join(" "));
      try {
        ls.renderCtx = gl;
        const program = new ls.ShaderProgram();
        program.compileAndLink("frag source", "vert source");
        return { program, logged };
      } finally {
        console.error = originalConsoleError;
        ls.renderCtx = originalCtx;
      }
    }

    it("records the driver log for each stage that fails to compile", () => {
      const ls = createLayerSystem();
      const { program, logged } = buildProgramWith(ls, stubGlWithBuildResults(false, true));
      assert.match(program.buildError, /fragment: ERROR: no matching overload for highp/);
      assert.match(program.buildError, /vertex: ERROR: no matching overload for highp/);
      assert.equal(logged.length, 2, "each failed stage is reported");
    });

    it("records a link failure even when both stages compile", () => {
      const ls = createLayerSystem();
      const { program } = buildProgramWith(ls, stubGlWithBuildResults(true, false));
      assert.match(program.buildError, /^link: ERROR: could not link$/);
    });

    it("leaves buildError null when the program builds", () => {
      const ls = createLayerSystem();
      const { program, logged } = buildProgramWith(ls, stubGlWithBuildResults(true, true));
      assert.equal(program.buildError, null);
      assert.equal(logged.length, 0);
      assert.notEqual(program.glProgram, null);
    });
  });

  // What `renderers.composite` falls back to when a caller has no layer style.
  it("defaultShapeStyleParams is a full-fill, no-knockout layer", () => {
    assert.deepEqual(defaultShapeStyleParams(), {
      fill: 1,
      blendIfTable: null,
      channelRestrictions: [1, 1, 1],
      knockout: 0,
      style: false,
      preserveDestAlpha: false,
    });
  });
});
