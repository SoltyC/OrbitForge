/**
 * WebGPU renderer setup.
 *
 * Three's WebGPURenderer falls back to WebGL2 automatically where WebGPU is
 * unavailable, so this is safe to use as the only path.
 *
 * The logarithmic depth buffer is not optional at planetary scale: with a
 * linear buffer spanning metres to thousands of kilometres, z-fighting makes
 * the surface unusable.
 */
import {
  ACESFilmicToneMapping,
  AmbientLight,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
  WebGPURenderer,
} from 'three/webgpu';

/** Near/far planes. The log depth buffer makes this range workable. */
const NEAR_PLANE = 0.1;
const FAR_PLANE = 1e9;

/** Sunlight distance; only the direction matters for a directional light. */
const SUN_DISTANCE = 1e8;

export interface RenderContext {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly sun: DirectionalLight;
}

export async function createRenderContext(
  canvas: HTMLCanvasElement,
): Promise<RenderContext> {
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    logarithmicDepthBuffer: true,
  });

  await renderer.init();

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new Scene();

  const camera = new PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    NEAR_PLANE,
    FAR_PLANE,
  );

  const sun = new DirectionalLight(0xfff4e6, 3.0);
  sun.position.set(SUN_DISTANCE, SUN_DISTANCE * 0.35, SUN_DISTANCE * 0.2);
  scene.add(sun);

  // A little fill so the night side is not pure black.
  scene.add(new AmbientLight(0x223044, 0.6));

  return { renderer, scene, camera, sun };
}

/** Keep the drawing buffer and projection matched to the window. */
export function attachResizeHandler(context: RenderContext): () => void {
  const onResize = (): void => {
    const { camera, renderer } = context;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  };

  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}
