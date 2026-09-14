/**
 * Structural checks on the WGSL sources.
 *
 * These shaders cannot be compiled here — that needs a GPU — so the failure
 * mode is a blank screen and a console error the tests never see. This checks
 * the classes of mistake that are detectable from the text alone, and that
 * have actually happened:
 *
 *   - More than one function in a string. Three's WGSL parser reads the first
 *     declaration and treats everything after it as that function's body, so a
 *     second function nests illegally and the shader will not build.
 *   - Calling a helper that was never passed as an include, which compiles as
 *     an unresolved identifier.
 *   - Unbalanced braces or parentheses from an editing slip.
 *
 * It cannot tell whether the maths is right. That is what the reference
 * implementation and its tests are for.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOUD_DENSITY_WGSL,
  CLOUD_DUAL_LOBE_WGSL,
  CLOUD_GRADIENT_WGSL,
  CLOUD_LIGHT_MARCH_WGSL,
  CLOUD_MARCH_WGSL,
  CLOUD_MULTI_SCATTER_WGSL,
  CLOUD_PHASE_WGSL,
  CLOUD_REMAP_WGSL,
  CLOUD_SPHERE_HIT_WGSL,
} from '../src/render/clouds/cloudShader.js';
import {
  MIE_PHASE_WGSL,
  SAMPLE_TRANSMITTANCE_WGSL,
  SKY_RADIANCE_WGSL,
  TRANSMITTANCE_UV_WGSL,
} from '../src/render/atmosphere/skyShader.js';

/** Every WGSL source, with the helpers each one is given as includes. */
const SOURCES: Record<string, { source: string; includes: string[] }> = {
  MIE_PHASE_WGSL: { source: MIE_PHASE_WGSL, includes: [] },
  TRANSMITTANCE_UV_WGSL: { source: TRANSMITTANCE_UV_WGSL, includes: [] },
  SAMPLE_TRANSMITTANCE_WGSL: {
    source: SAMPLE_TRANSMITTANCE_WGSL,
    includes: [TRANSMITTANCE_UV_WGSL],
  },
  SKY_RADIANCE_WGSL: {
    source: SKY_RADIANCE_WGSL,
    includes: [MIE_PHASE_WGSL, TRANSMITTANCE_UV_WGSL, SAMPLE_TRANSMITTANCE_WGSL],
  },
  CLOUD_REMAP_WGSL: { source: CLOUD_REMAP_WGSL, includes: [] },
  CLOUD_GRADIENT_WGSL: { source: CLOUD_GRADIENT_WGSL, includes: [CLOUD_REMAP_WGSL] },
  CLOUD_DENSITY_WGSL: {
    source: CLOUD_DENSITY_WGSL,
    includes: [CLOUD_REMAP_WGSL, CLOUD_GRADIENT_WGSL],
  },
  CLOUD_PHASE_WGSL: { source: CLOUD_PHASE_WGSL, includes: [] },
  CLOUD_DUAL_LOBE_WGSL: { source: CLOUD_DUAL_LOBE_WGSL, includes: [CLOUD_PHASE_WGSL] },
  CLOUD_MULTI_SCATTER_WGSL: {
    source: CLOUD_MULTI_SCATTER_WGSL,
    includes: [CLOUD_PHASE_WGSL, CLOUD_DUAL_LOBE_WGSL],
  },
  CLOUD_LIGHT_MARCH_WGSL: {
    source: CLOUD_LIGHT_MARCH_WGSL,
    includes: [CLOUD_REMAP_WGSL, CLOUD_GRADIENT_WGSL, CLOUD_DENSITY_WGSL],
  },
  CLOUD_SPHERE_HIT_WGSL: { source: CLOUD_SPHERE_HIT_WGSL, includes: [] },
  CLOUD_MARCH_WGSL: {
    source: CLOUD_MARCH_WGSL,
    includes: [
      CLOUD_REMAP_WGSL,
      CLOUD_GRADIENT_WGSL,
      CLOUD_DENSITY_WGSL,
      CLOUD_PHASE_WGSL,
      CLOUD_DUAL_LOBE_WGSL,
      CLOUD_MULTI_SCATTER_WGSL,
      CLOUD_LIGHT_MARCH_WGSL,
      CLOUD_SPHERE_HIT_WGSL,
    ],
  },
};

/**
 * WGSL builtins and keywords the shaders use. Anything called that is not one
 * of these has to be declared by the source or one of its includes.
 */
const BUILTINS = new Set([
  'abs', 'ceil', 'clamp', 'cos', 'dot', 'exp', 'floor', 'fract', 'length',
  'max', 'min', 'mix', 'normalize', 'pow', 'select', 'sin', 'sqrt', 'step',
  'textureLoad', 'textureSampleLevel', 'textureDimensions',
  'f32', 'i32', 'u32', 'bool',
  'vec2', 'vec3', 'vec4', 'vec2f', 'vec3f', 'vec4f',
  'if', 'for', 'while', 'return', 'let', 'var', 'switch',
]);

function declaredFunctions(source: string): string[] {
  return [...source.matchAll(/\bfn\s+([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!);
}

function calledFunctions(source: string): string[] {
  // Identifiers immediately followed by "(", minus the declarations themselves.
  const declared = new Set(declaredFunctions(source));
  const calls = [...source.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!);
  return calls.filter((name) => !declared.has(name) || true).filter(Boolean);
}

describe.each(Object.entries(SOURCES))('%s', (name, { source, includes }) => {
  it('declares exactly one function', () => {
    // Three's parser folds anything after the first declaration into its body.
    expect(declaredFunctions(source), `${name} must hold a single fn`).toHaveLength(1);
  });

  it('balances braces and parentheses', () => {
    expect(count(source, '{')).toBe(count(source, '}'));
    expect(count(source, '(')).toBe(count(source, ')'));
  });

  it('calls only builtins and functions it was given', () => {
    const available = new Set<string>([
      ...BUILTINS,
      ...declaredFunctions(source),
      ...includes.flatMap(declaredFunctions),
    ]);

    const missing = calledFunctions(source).filter(
      (called) => !available.has(called),
    );

    expect(missing, `${name} calls undeclared: ${[...new Set(missing)].join(', ')}`)
      .toHaveLength(0);
  });

  it('declares a return type', () => {
    expect(source).toMatch(/\)\s*->\s*\S+/);
  });
});

describe('include graph', () => {
  it('gives every source the helpers its callees need, transitively', () => {
    // A helper that itself calls another helper needs that one present too;
    // WGSL has no forward declarations to fall back on.
    for (const [name, { source, includes }] of Object.entries(SOURCES)) {
      const available = new Set<string>([
        ...BUILTINS,
        ...declaredFunctions(source),
        ...includes.flatMap(declaredFunctions),
      ]);

      for (const include of includes) {
        for (const called of calledFunctions(include)) {
          expect(
            available.has(called),
            `${name} includes a helper that calls ${called}, which is missing`,
          ).toBe(true);
        }
      }
    }
  });

  it('names every function distinctly across all sources', () => {
    // Duplicates would collide once three concatenates the includes.
    const all = Object.values(SOURCES).flatMap(({ source }) => declaredFunctions(source));
    expect(new Set(all).size).toBe(all.length);
  });
});

describe('transcription fidelity', () => {
  it('keeps the sky and cloud marches integrating segments in closed form', () => {
    // Both references integrate each segment analytically rather than sampling
    // its midpoint. Losing that silently changes the result everywhere.
    expect(SKY_RADIANCE_WGSL).toContain('exp( -extinction * stepSize )');
    expect(CLOUD_MARCH_WGSL).toContain('exp( -density * stepSize )');
  });

  it('returns opacity from both marches', () => {
    // Without an alpha channel the sky can only add light, never hide what is
    // behind it — which is what left stars shining through a daytime sky.
    expect(SKY_RADIANCE_WGSL).toMatch(/->\s*vec4<f32>/);
    expect(CLOUD_MARCH_WGSL).toMatch(/->\s*vec4<f32>/);
  });

  it('keeps erosion in the cloud light march', () => {
    // Dropping the detail fetch from the innermost loop is the usual saving
    // and was measured as wrong: it raised mean optical depth towards the sun
    // by 44%, shadowing cloud that is not there.
    expect(CLOUD_LIGHT_MARCH_WGSL).toContain('cloudDensityAt');
    expect(CLOUD_DENSITY_WGSL).toContain('detailTex');
  });
});

function count(text: string, character: string): number {
  let total = 0;
  for (const c of text) if (c === character) total++;
  return total;
}
