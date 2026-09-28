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

function createLayerSystem() {
  stubWebGlCanvas();
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
