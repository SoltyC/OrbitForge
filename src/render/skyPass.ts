/**
 * Renders the sky and clouds at reduced resolution, then composites the result
 * behind everything else.
 *
 * The atmosphere and cloud marches cost tens to hundreds of volume samples per
 * pixel, so their cost is set almost entirely by how many pixels there are. On
 * a retina display at device pixel ratio 2 that is around eight million, and it
 * is the whole performance story — the marches themselves were already
 * measured and tuned.
 *
 * Halving each axis is a quarter of the work, and it costs almost nothing
 * visually: both are smooth gradients with no high-frequency detail to lose.
 * This is exactly why half-resolution volumetrics are standard. Everything
 * with real edges — the vessel, the planet, the orbit lines — still draws at
 * full resolution in the second pass.
 *
 * Splitting the passes by toggling visibility rather than by moving objects
 * into a second scene keeps the scene graph, the floating origin and every
 * transform exactly as they were.
 */
import { NodeMaterial, QuadMesh, RenderTarget } from 'three/webgpu';
import type { Object3D, PerspectiveCamera, Scene, WebGPURenderer } from 'three/webgpu';
import { texture, uv } from 'three/tsl';

/**
 * Fraction of the full resolution the sky is drawn at. A quarter of the pixels.
 */
export const SKY_SCALE = 0.5;

export interface SkyPassTargets {
  /** Drawn in the sky pass: the atmosphere shell and the starfield. */
  readonly background: readonly Object3D[];
  /** Drawn in the main pass: everything with edges worth resolving. */
  readonly foreground: readonly Object3D[];
}

export class SkyPass {
  private readonly target: RenderTarget;
  private readonly quad: QuadMesh;
  private readonly material: NodeMaterial;

  constructor(
    private readonly renderer: WebGPURenderer,
    width: number,
    height: number,
  ) {
    this.target = new RenderTarget(
      Math.max(1, Math.floor(width * SKY_SCALE)),
      Math.max(1, Math.floor(height * SKY_SCALE)),
      // No depth buffer: the sky pass draws only the background, and the
      // marches already work out where the ground cuts a ray short.
      { depthBuffer: false, stencilBuffer: false },
    );

    const material = new NodeMaterial();
    material.colorNode = texture(this.target.texture, uv());
    material.depthTest = false;
    material.depthWrite = false;
    material.transparent = false;

    this.material = material;
    this.quad = new QuadMesh(material);
  }

  setSize(width: number, height: number): void {
    this.target.setSize(
      Math.max(1, Math.floor(width * SKY_SCALE)),
      Math.max(1, Math.floor(height * SKY_SCALE)),
    );
  }

  /**
   * Draw a frame: sky into the reduced target, then the full-resolution scene
   * over the top of it.
   */
  render(
    scene: Scene,
    camera: PerspectiveCamera,
    targets: SkyPassTargets,
  ): void {
    setVisible(targets.background, true);
    setVisible(targets.foreground, false);

    this.renderer.setRenderTarget(this.target);
    this.renderer.render(scene, camera);

    // The composite writes the sky across the whole frame before anything
    // else, so no clear of the main buffer's colour is wanted after it.
    this.renderer.setRenderTarget(null);
    this.quad.render(this.renderer);

    setVisible(targets.background, false);
    setVisible(targets.foreground, true);

    // Keep the colour the quad just laid down, but start the depth buffer
    // fresh so the scene occludes itself correctly.
    this.renderer.autoClearColor = false;
    this.renderer.render(scene, camera);
    this.renderer.autoClearColor = true;

    setVisible(targets.background, true);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}

function setVisible(objects: readonly Object3D[], visible: boolean): void {
  for (const object of objects) object.visible = visible;
}
