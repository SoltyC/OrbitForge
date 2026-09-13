/**
 * Immutable 3D vector in f64. All operations return new instances.
 *
 * This is the simulation's vector type and is deliberately independent of
 * Three.js so the physics can be tested without a renderer.
 */
export class Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static readonly ZERO = new Vec3(0, 0, 0);
  static readonly UP = new Vec3(0, 1, 0);

  add(v: Vec3): Vec3 {
    return new Vec3(this.x + v.x, this.y + v.y, this.z + v.z);
  }

  sub(v: Vec3): Vec3 {
    return new Vec3(this.x - v.x, this.y - v.y, this.z - v.z);
  }

  scale(s: number): Vec3 {
    return new Vec3(this.x * s, this.y * s, this.z * s);
  }

  negate(): Vec3 {
    return new Vec3(-this.x, -this.y, -this.z);
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  cross(v: Vec3): Vec3 {
    return new Vec3(
      this.y * v.z - this.z * v.y,
      this.z * v.x - this.x * v.z,
      this.x * v.y - this.y * v.x,
    );
  }

  get lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  get length(): number {
    return Math.sqrt(this.lengthSq);
  }

  /** Unit vector. Returns ZERO for a zero-length vector rather than NaN. */
  normalized(): Vec3 {
    const len = this.length;
    return len > 0 ? this.scale(1 / len) : Vec3.ZERO;
  }

  distanceTo(v: Vec3): number {
    return this.sub(v).length;
  }

  /** Component of this vector along `axis` (which need not be normalized). */
  projectOnto(axis: Vec3): Vec3 {
    const unit = axis.normalized();
    return unit.scale(this.dot(unit));
  }

  /** Component of this vector perpendicular to `axis`. */
  rejectFrom(axis: Vec3): Vec3 {
    return this.sub(this.projectOnto(axis));
  }

  lerp(v: Vec3, t: number): Vec3 {
    return new Vec3(
      this.x + (v.x - this.x) * t,
      this.y + (v.y - this.y) * t,
      this.z + (v.z - this.z) * t,
    );
  }

  get isFinite(): boolean {
    return (
      Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z)
    );
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }
}

/** Angle in radians between two vectors, clamped against float error. */
export function angleBetween(a: Vec3, b: Vec3): number {
  const denom = a.length * b.length;
  if (denom === 0) return 0;
  const cos = Math.min(1, Math.max(-1, a.dot(b) / denom));
  return Math.acos(cos);
}
