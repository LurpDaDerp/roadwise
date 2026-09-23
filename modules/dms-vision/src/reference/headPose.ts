// Head pose from MediaPipe's facial transformation matrix, and gaze angles from the network's vector.
// Ported verbatim to Swift and Kotlin.
//
// MediaPipe's metric space is right-handed with x toward image right, y up and z toward the viewer.
// A face looking straight into the lens has R ≈ I. The matrix arrives COLUMN-MAJOR (OpenGL layout),
// computed from the buffer-frame landmarks, so it is first rotated into the upright frame. A
// clockwise image rotation by θ is a rotation about z by −θ in this y-up space.
//
// Angles, degrees, camera frame:
// - yaw   = atan2(f.x, f.z), with f = R·(0,0,1) the face's forward vector; + = face turned toward
//   image right;
// - pitch = atan2(f.y, hypot(f.x, f.z)); + = up;
// - roll  = the up vector u = R·(0,1,0) after undoing yaw and pitch: u' = Rx(pitch)·Ry(−yaw)·u,
//   roll = atan2(u'.x, u'.y); + = clockwise on screen.
// For R = Ry(yaw)·Rx(−pitch)·Rz(−roll) these return (yaw, pitch, roll) exactly (the oracle test).
import type { Rotation } from './landmarks';

const DEG = 180 / Math.PI;

export interface HeadPose {
  yawDeg: number;
  pitchDeg: number;
  rollDeg: number;
}

/** R[row][col] of a column-major 4×4. */
function at(m: ArrayLike<number>, row: number, col: number): number {
  return m[col * 4 + row]!;
}

export function headPoseFromMatrix(m: ArrayLike<number>, rotation: Rotation): HeadPose {
  if (m.length !== 16) throw new Error('the transformation matrix has 16 entries');
  // R_up = Rz(−θ) · R_buf, with θ the clockwise upright rotation.
  const th = (-rotation * Math.PI) / 180;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const r = (row: number, col: number): number => {
    const a = at(m, 0, col);
    const b = at(m, 1, col);
    if (row === 0) return c * a - s * b;
    if (row === 1) return s * a + c * b;
    return at(m, 2, col);
  };
  const fx = r(0, 2);
  const fy = r(1, 2);
  const fz = r(2, 2);
  const yaw = Math.atan2(fx, fz);
  const pitch = Math.atan2(fy, Math.hypot(fx, fz));
  const ux = r(0, 1);
  const uy = r(1, 1);
  const uz = r(2, 1);
  // Ry(−yaw) then Rx(pitch), in y-up coordinates.
  const cy = Math.cos(-yaw);
  const sy = Math.sin(-yaw);
  const x1 = cy * ux + sy * uz;
  const y1 = uy;
  const z1 = -sy * ux + cy * uz;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const x2 = x1;
  const y2 = cp * y1 - sp * z1;
  const roll = Math.atan2(x2, y2);
  return { yawDeg: yaw * DEG, pitchDeg: pitch * DEG, rollDeg: roll * DEG };
}

/**
 * `gaze_direct` output → degrees in the camera frame. The model stores `s = diag(1, 1, −1) ×` the
 * physical OpenCV direction (meta.json): yaw = atan2(s.x, s.z) (+ image right),
 * pitch = atan2(−s.y, hypot(s.x, s.z)) (+ up).
 */
export function gazeAngles(v: ArrayLike<number>): { yawDeg: number; pitchDeg: number } {
  const x = v[0]!;
  const y = v[1]!;
  const z = v[2]!;
  return { yawDeg: Math.atan2(x, z) * DEG, pitchDeg: Math.atan2(-y, Math.hypot(x, z)) * DEG };
}

/** Column-major 4×4 for R = Ry(yaw)·Rx(−pitch)·Rz(−roll) (y-up), rotated into the BUFFER frame of `rotation`. Generator and oracle only. */
export function matrixFromPose(yawDeg: number, pitchDeg: number, rollDeg: number, rotation: Rotation, tz = -40): number[] {
  const y = yawDeg / DEG;
  const p = pitchDeg / DEG;
  const rl = rollDeg / DEG;
  const Ry = [
    [Math.cos(y), 0, Math.sin(y)],
    [0, 1, 0],
    [-Math.sin(y), 0, Math.cos(y)],
  ];
  const Rx = [
    [1, 0, 0],
    [0, Math.cos(-p), -Math.sin(-p)],
    [0, Math.sin(-p), Math.cos(-p)],
  ];
  const Rz = (a: number) => [
    [Math.cos(a), -Math.sin(a), 0],
    [Math.sin(a), Math.cos(a), 0],
    [0, 0, 1],
  ];
  const mul = (A: number[][], B: number[][]) =>
    A.map((row, i) => B[0]!.map((_, j) => row.reduce((acc, _v, k) => acc + A[i]![k]! * B[k]![j]!, 0)));
  const up = mul(mul(Ry, Rx), Rz(-rl));
  // R_buf = Rz(+θ) · R_up (the inverse of headPoseFromMatrix's step).
  const buf = mul(Rz((rotation * Math.PI) / 180), up);
  const m = new Array<number>(16).fill(0);
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) m[col * 4 + row] = buf[row]![col]!;
  m[14] = tz;
  m[15] = 1;
  return m;
}
