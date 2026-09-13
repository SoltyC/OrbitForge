/**
 * Immutable unit quaternion for vessel attitude. All operations return new
 * instances. Convention: (x, y, z, w) with w scalar last.
 */
import { Vec3 } from './vec3.js';

export class Quat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;

  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  static readonly IDENTITY = new Quat(0, 0, 0, 1);

  static fromAxisAngle(axis: Vec3, radians: number): Quat {
    const unit = axis.normalized();
    const half = radians / 2;
    const s = Math.sin(half);
    return new Quat(unit.x * s, unit.y * s, unit.z * s, Math.cos(half));
  }

  /** Shortest-arc rotation taking unit vector `from` to unit vector `to`. */
  static fromUnitVectors(from: Vec3, to: Vec3): Quat {
    const a = from.normalized();
    const b = to.normalized();
    const d = a.dot(b);

    // Antiparallel: rotation axis is ambiguous, pick any perpendicular axis.
    if (d < -0.999999) {
      const axis = Math.abs(a.x) > 0.9 ? new Vec3(0, 1, 0) : new Vec3(1, 0, 0);
      return Quat.fromAxisAngle(a.cross(axis), Math.PI);
    }

    const c = a.cross(b);
    return new Quat(c.x, c.y, c.z, 1 + d).normalized();
  }

  multiply(q: Quat): Quat {
    return new Quat(
      this.w * q.x + this.x * q.w + this.y * q.z - this.z * q.y,
      this.w * q.y - this.x * q.z + this.y * q.w + this.z * q.x,
      this.w * q.z + this.x * q.y - this.y * q.x + this.z * q.w,
      this.w * q.w - this.x * q.x - this.y * q.y - this.z * q.z,
    );
  }

  conjugate(): Quat {
    return new Quat(-this.x, -this.y, -this.z, this.w);
  }

  get length(): number {
    return Math.sqrt(
      this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w,
    );
  }

  normalized(): Quat {
    const len = this.length;
    if (len === 0) return Quat.IDENTITY;
    return new Quat(this.x / len, this.y / len, this.z / len, this.w / len);
  }

  /** Rotate a vector by this quaternion. */
  rotate(v: Vec3): Vec3 {
    const u = new Vec3(this.x, this.y, this.z);
    const uv = u.cross(v);
    const uuv = u.cross(uv);
    return v.add(uv.scale(2 * this.w)).add(uuv.scale(2));
  }

  /**
   * Integrate attitude forward by angular velocity (rad/s, world frame) over
   * `dt`, returning the new normalized orientation.
   */
  integrate(angularVelocity: Vec3, dt: number): Quat {
    const omega = new Quat(
      angularVelocity.x,
      angularVelocity.y,
      angularVelocity.z,
      0,
    );
    const derivative = omega.multiply(this);
    return new Quat(
      this.x + derivative.x * 0.5 * dt,
      this.y + derivative.y * 0.5 * dt,
      this.z + derivative.z * 0.5 * dt,
      this.w + derivative.w * 0.5 * dt,
    ).normalized();
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w];
  }
}
