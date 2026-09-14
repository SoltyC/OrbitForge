/**
 * Cube-sphere mapping.
 *
 * Terrain is addressed as six square faces rather than by latitude and
 * longitude. A lat/long grid has two poles where every column converges — the
 * cells there are slivers, the texel density is unbounded, and any quadtree
 * built on it subdivides into degeneracy. Six faces of a cube have neither
 * problem: every chunk is a well-formed quad wherever it sits on the globe.
 *
 * The face coordinates are tangent-warped before projection. Projecting a
 * uniform grid straight onto the sphere bunches samples badly towards the face
 * centres — the corners of a cube are much further from its centre than the
 * face middles are — and `tan(u * pi/4)` very nearly cancels that out, which
 * matters because chunk size is what drives level-of-detail selection.
 */
import { Vec3 } from '../sim/vec3.js';

/** The six faces, in a fixed order that indices can rely on. */
export const FACE_COUNT = 6;

export type FaceIndex = 0 | 1 | 2 | 3 | 4 | 5;

/**
 * Axis basis per face: the outward normal, and the directions that `u` and `v`
 * run along. Chosen so every face is right-handed looking inward, which keeps
 * generated triangles consistently wound.
 */
interface FaceBasis {
  readonly normal: Vec3;
  readonly uAxis: Vec3;
  readonly vAxis: Vec3;
}

const FACES: readonly FaceBasis[] = [
  // +X, -X
  { normal: new Vec3(1, 0, 0), uAxis: new Vec3(0, 0, -1), vAxis: new Vec3(0, 1, 0) },
  { normal: new Vec3(-1, 0, 0), uAxis: new Vec3(0, 0, 1), vAxis: new Vec3(0, 1, 0) },
  // +Y, -Y
  { normal: new Vec3(0, 1, 0), uAxis: new Vec3(1, 0, 0), vAxis: new Vec3(0, 0, -1) },
  { normal: new Vec3(0, -1, 0), uAxis: new Vec3(1, 0, 0), vAxis: new Vec3(0, 0, 1) },
  // +Z, -Z
  { normal: new Vec3(0, 0, 1), uAxis: new Vec3(1, 0, 0), vAxis: new Vec3(0, 1, 0) },
  { normal: new Vec3(0, 0, -1), uAxis: new Vec3(-1, 0, 0), vAxis: new Vec3(0, 1, 0) },
];

export function faceBasis(face: FaceIndex): FaceBasis {
  const basis = FACES[face];
  if (!basis) throw new Error(`No such cube face: ${face}`);
  return basis;
}

/**
 * Tangent warp that evens out sample spacing across a face.
 * Maps [-1, 1] onto itself, with the identity at the ends and the centre.
 */
export function warpFaceCoordinate(t: number): number {
  return Math.tan(t * (Math.PI / 4));
}

/** Inverse of the tangent warp. */
export function unwarpFaceCoordinate(t: number): number {
  return Math.atan(t) / (Math.PI / 4);
}

/**
 * Unit direction for a point on a face.
 *
 * @param u,v Face coordinates in [-1, 1].
 */
export function faceToDirection(face: FaceIndex, u: number, v: number): Vec3 {
  const basis = faceBasis(face);

  const wu = warpFaceCoordinate(u);
  const wv = warpFaceCoordinate(v);

  return basis.normal
    .add(basis.uAxis.scale(wu))
    .add(basis.vAxis.scale(wv))
    .normalized();
}

export interface FaceCoordinate {
  readonly face: FaceIndex;
  readonly u: number;
  readonly v: number;
}

/**
 * Which face a direction belongs to, and where on it.
 *
 * The face is the one whose axis the direction points most strongly along,
 * which is exactly the largest absolute component.
 */
export function directionToFace(direction: Vec3): FaceCoordinate {
  const d = direction.normalized();

  const ax = Math.abs(d.x);
  const ay = Math.abs(d.y);
  const az = Math.abs(d.z);

  let face: FaceIndex;
  if (ax >= ay && ax >= az) face = d.x >= 0 ? 0 : 1;
  else if (ay >= az) face = d.y >= 0 ? 2 : 3;
  else face = d.z >= 0 ? 4 : 5;

  const basis = faceBasis(face);

  // Project onto the face plane, then undo the tangent warp.
  const scale = d.dot(basis.normal);
  if (scale === 0) return { face, u: 0, v: 0 };

  return {
    face,
    u: unwarpFaceCoordinate(d.dot(basis.uAxis) / scale),
    v: unwarpFaceCoordinate(d.dot(basis.vAxis) / scale),
  };
}

/**
 * Angular size of one face-coordinate unit at a point, in radians.
 *
 * Level-of-detail selection needs to know how big a chunk actually is on the
 * sphere, and the warp means that is not constant across a face.
 */
export function faceScaleAt(face: FaceIndex, u: number, v: number): number {
  const centre = faceToDirection(face, u, v);
  const nudge = 1e-4;
  const stepped = faceToDirection(face, u + nudge, v);

  return centre.distanceTo(stepped) / nudge;
}
