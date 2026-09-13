/**
 * The VAB: build a craft by clicking attach nodes.
 *
 * Interaction is click-to-place rather than drag-and-drop. Free attach nodes
 * are drawn as spheres; pick a part from the catalogue, click a node, and it
 * goes there. Clicking a placed part selects it; Delete removes it along with
 * everything mounted below.
 */
import {
  AmbientLight,
  DirectionalLight,
  GridHelper,
  Group,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three/webgpu';
import type { Body } from '../bodies/types.js';
import { assemble } from '../parts/assembly.js';
import type { Assembly } from '../parts/assembly.js';
import { attachPart, detachPart, findInstance } from '../parts/craft.js';
import type { Craft } from '../parts/craft.js';
import { CraftError } from '../parts/craft.js';
import { createPathfinderCraft } from '../parts/testVehicle.js';
import { findPart } from '../parts/catalogue.js';
import { buildCraftView, disposeCraftView, setHoveredNode } from './craftView.js';
import type { CraftView } from './craftView.js';
import { EditorPanels } from './editorPanels.js';

/** Distance the editor camera starts at, as a multiple of craft height. */
const CAMERA_FRAMING = 2.2;
const MIN_CAMERA_DISTANCE = 6;
const ORBIT_SENSITIVITY = 0.006;
const ZOOM_SENSITIVITY = 0.0015;
const MAX_PITCH = Math.PI / 2 - 0.08;
/** A drag beyond this many pixels is a camera move, not a click. */
const CLICK_SLOP_PIXELS = 4;

export interface EditorCallbacks {
  /** Called when the player commits to flying the craft they built. */
  readonly onLaunch: (craft: Craft) => void;
}

export class Editor {
  readonly scene = new Scene();
  readonly camera: PerspectiveCamera;

  private craft: Craft = createPathfinderCraft();
  private assembly: Assembly;
  private view: CraftView | null = null;
  private readonly viewRoot = new Group();

  private selectedPartId: string | null = null;
  private selectedInstanceId: string | null = null;
  private symmetry = 1;

  private yaw = 0.7;
  private pitch = 0.15;
  private distance = 30;
  private isDragging = false;
  private dragDistance = 0;

  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly panels: EditorPanels;
  private message: HTMLElement | null = null;

  constructor(
    overlay: HTMLElement,
    private readonly body: Body,
    private readonly callbacks: EditorCallbacks,
  ) {
    this.camera = new PerspectiveCamera(
      50,
      window.innerWidth / window.innerHeight,
      0.05,
      5_000,
    );

    this.scene.add(this.viewRoot);
    this.scene.add(new AmbientLight(0x668099, 1.4));

    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(12, 20, 14);
    this.scene.add(key);

    const fill = new DirectionalLight(0x88aaff, 0.7);
    fill.position.set(-14, 6, -10);
    this.scene.add(fill);

    const grid = new GridHelper(80, 40, 0x33506a, 0x1d2c3a);
    grid.position.y = 0;
    this.scene.add(grid);

    this.panels = new EditorPanels(overlay, {
      onSelectPart: (partId) => this.selectCatalogPart(partId),
      onSymmetryChange: (symmetry) => this.setSymmetry(symmetry),
      onLaunch: () => this.callbacks.onLaunch(this.craft),
      onClear: () => this.clear(),
    });

    this.message = document.createElement('div');
    this.message.className = 'editor-message';
    overlay.append(this.message);

    this.assembly = assemble(this.craft);
    this.rebuild();
    this.distance = Math.max(MIN_CAMERA_DISTANCE, this.assembly.height * CAMERA_FRAMING);
  }

  setVisible(visible: boolean): void {
    this.panels.setVisible(visible);
    if (this.message) this.message.style.display = visible ? '' : 'none';
  }

  getCraft(): Craft {
    return this.craft;
  }

  attach(element: HTMLElement): () => void {
    const onPointerDown = (): void => {
      this.isDragging = true;
      this.dragDistance = 0;
    };

    const onPointerUp = (event: PointerEvent): void => {
      const wasDrag = this.dragDistance > CLICK_SLOP_PIXELS;
      this.isDragging = false;
      if (!wasDrag) this.handleClick(event, element);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (this.isDragging) {
        this.dragDistance += Math.abs(event.movementX) + Math.abs(event.movementY);
        this.yaw -= event.movementX * ORBIT_SENSITIVITY;
        this.pitch = clamp(
          this.pitch + event.movementY * ORBIT_SENSITIVITY,
          -MAX_PITCH,
          MAX_PITCH,
        );
        return;
      }
      this.updateHover(event, element);
    };

    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      this.distance = clamp(
        this.distance * Math.exp(event.deltaY * ZOOM_SENSITIVITY),
        MIN_CAMERA_DISTANCE,
        600,
      );
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      event.preventDefault();
      this.deleteSelected();
    };

    element.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);
    element.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyDown);

    return () => {
      element.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
    };
  }

  /** Reframe the camera each render. */
  update(): void {
    const focusHeight = this.assembly.height / 2;
    const target = new Vector3(0, focusHeight, 0);

    const horizontal = Math.cos(this.pitch);
    const offset = new Vector3(
      Math.cos(this.yaw) * horizontal,
      Math.sin(this.pitch),
      Math.sin(this.yaw) * horizontal,
    ).multiplyScalar(this.distance);

    this.camera.position.copy(target).add(offset);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
  }

  onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
  }

  private selectCatalogPart(partId: string): void {
    this.selectedPartId = partId;
    this.panels.setSelectedPart(partId);
    this.showMessage(`${findPart(partId).name} selected — click a blue node to place`);
  }

  private setSymmetry(symmetry: number): void {
    this.symmetry = symmetry;
    this.panels.setSymmetry(symmetry);
  }

  private clear(): void {
    this.craft = createPathfinderCraft();
    this.selectedInstanceId = null;
    this.rebuild();
    this.showMessage('Reset to Pathfinder I');
  }

  private handleClick(event: PointerEvent, element: HTMLElement): void {
    const hits = this.pick(event, element);
    if (!this.view || hits.length === 0) return;

    const hit = hits[0]!;

    const nodeTarget = this.view.nodeTargets.get(hit.object.uuid);
    if (nodeTarget) {
      this.placeAt(nodeTarget.instanceId, nodeTarget.nodeId);
      return;
    }

    const instanceId = this.view.partMeshes.get(hit.object.uuid);
    if (instanceId) {
      this.selectedInstanceId = instanceId;
      const part = findInstance(this.craft, instanceId);
      this.showMessage(`${findPart(part.partId).name} — Delete to remove`);
      this.rebuild();
    }
  }

  private placeAt(instanceId: string, nodeId: string): void {
    if (!this.selectedPartId) {
      this.showMessage('Pick a part from the catalogue first');
      return;
    }

    try {
      this.craft = attachPart(this.craft, {
        parentId: instanceId,
        parentNodeId: nodeId,
        partId: this.selectedPartId,
        symmetry: this.symmetry,
      });
      this.rebuild();
    } catch (error: unknown) {
      // A rejected attach is normal user error, not a crash.
      this.showMessage(
        error instanceof CraftError ? error.message : 'Could not place that part',
      );
    }
  }

  private deleteSelected(): void {
    if (!this.selectedInstanceId) return;

    try {
      this.craft = detachPart(this.craft, this.selectedInstanceId);
      this.selectedInstanceId = null;
      this.rebuild();
    } catch (error: unknown) {
      this.showMessage(
        error instanceof CraftError ? error.message : 'Could not remove that part',
      );
    }
  }

  private updateHover(event: PointerEvent, element: HTMLElement): void {
    if (!this.view) return;
    const hits = this.pick(event, element);
    const first = hits[0];
    const uuid =
      first && this.view.nodeTargets.has(first.object.uuid) ? first.object.uuid : null;
    setHoveredNode(this.view, uuid);
  }

  private pick(
    event: PointerEvent,
    element: HTMLElement,
  ): ReturnType<Raycaster['intersectObjects']> {
    const bounds = element.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.raycaster.intersectObjects(this.viewRoot.children, true);
  }

  private rebuild(): void {
    this.assembly = assemble(this.craft);

    if (this.view) {
      this.viewRoot.remove(this.view.group);
      disposeCraftView(this.view);
    }

    this.view = buildCraftView(this.craft, this.assembly, this.selectedInstanceId);
    this.viewRoot.add(this.view.group);

    this.panels.update(this.assembly, this.body);
    this.panels.setSymmetry(this.symmetry);
  }

  private showMessage(text: string): void {
    if (this.message) this.message.textContent = text;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
