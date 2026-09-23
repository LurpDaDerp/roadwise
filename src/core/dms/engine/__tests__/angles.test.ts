// Frames of reference (plan §M1): camera frame (yaw + toward image right, pitch + up), the roll
// correction about the optical axis, the driver frame (LHD yawDrv = −yawCam, RHD +yawCam), angles
// relative to a centre, angular distance, wrapping and the GNSS course rate.
import {
  angularDistanceDeg,
  courseRateDegS,
  fromDirection,
  relative,
  rollCorrect,
  toDirection,
  toDriverFrame,
  wrapDeg180,
} from '../angles';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThanOrEqual(eps);

describe('toDirection / fromDirection', () => {
  test('the axes: yaw + is image right (x), pitch + is up (y), straight ahead is +z', () => {
    const [x, y, z] = toDirection({ yaw: 0, pitch: 0 });
    expect([x, y, z]).toEqual([0, 0, 1]);
    const right = toDirection({ yaw: 90, pitch: 0 });
    close(right[0], 1);
    close(right[2], 0);
    const up = toDirection({ yaw: 0, pitch: 90 });
    close(up[1], 1);
  });

  test('round trip over a grid', () => {
    for (let yaw = -170; yaw <= 170; yaw += 17) {
      for (let pitch = -80; pitch <= 80; pitch += 16) {
        const back = fromDirection(toDirection({ yaw, pitch }));
        close(back.yaw, yaw, 1e-9);
        close(back.pitch, pitch, 1e-9);
      }
    }
  });
});

describe('rollCorrect: the direction rotated about the optical axis by −roll', () => {
  test('30° of roll against an exact vector rotation', () => {
    // A phone rolled by +30° sees a gaze that is truly (yaw 0, pitch 20) rotated by R(+30°), where
    // R(α) takes image-up (0, 1) to (sin α, cos α): the head-pose roll convention.
    const a = (30 * Math.PI) / 180;
    const [x, y, z] = toDirection({ yaw: 0, pitch: 20 });
    const seen = fromDirection([x * Math.cos(a) + y * Math.sin(a), -x * Math.sin(a) + y * Math.cos(a), z]);
    expect(seen.yaw).toBeGreaterThan(0); // the tilt moved it toward image right
    const fixed = rollCorrect(seen, 30);
    close(fixed.yaw, 0, 1e-9);
    close(fixed.pitch, 20, 1e-9);
  });

  test('roll 0 is the identity, and ±roll are inverses', () => {
    const g = { yaw: 12.5, pitch: -7.25 };
    const same = rollCorrect(g, 0);
    close(same.yaw, g.yaw);
    close(same.pitch, g.pitch);
    const back = rollCorrect(rollCorrect(g, 17), -17);
    close(back.yaw, g.yaw, 1e-9);
    close(back.pitch, g.pitch, 1e-9);
  });

  test('it rotates the vector, not the angles: a pure yaw under 90° roll becomes a pure pitch', () => {
    const r = rollCorrect({ yaw: 10, pitch: 0 }, 90);
    close(r.yaw, 0, 1e-9);
    close(r.pitch, 10, 1e-9);
  });
});

describe('toDriverFrame', () => {
  test('LHD: yawDrv = −yawCam (the passenger is on the image left); pitch unchanged', () => {
    expect(toDriverFrame({ yaw: 20, pitch: -5 }, 'left')).toEqual({ yaw: -20, pitch: -5 });
  });

  test('RHD: yawDrv = +yawCam', () => {
    expect(toDriverFrame({ yaw: 20, pitch: -5 }, 'right')).toEqual({ yaw: 20, pitch: -5 });
  });

  test('LHD and RHD are mirror images of each other over a grid', () => {
    for (let yaw = -60; yaw <= 60; yaw += 7.5) {
      for (const pitch of [-30, 0, 12]) {
        const l = toDriverFrame({ yaw, pitch }, 'left');
        const r = toDriverFrame({ yaw, pitch }, 'right');
        expect(l.yaw + r.yaw).toBe(0);
        expect(l.pitch).toBe(r.pitch);
      }
    }
  });
});

describe('relative / wrapDeg180 / angularDistanceDeg', () => {
  test('relative subtracts the centre, and wraps yaw into (−180, 180]', () => {
    expect(relative({ yaw: 10, pitch: 5 }, { yaw: 4, pitch: -3 })).toEqual({ yaw: 6, pitch: 8 });
    expect(relative({ yaw: -170, pitch: 0 }, { yaw: 170, pitch: 0 }).yaw).toBe(20);
  });

  test('wrapDeg180', () => {
    expect(wrapDeg180(0)).toBe(0);
    expect(wrapDeg180(180)).toBe(180);
    expect(wrapDeg180(-180)).toBe(180);
    expect(wrapDeg180(190)).toBe(-170);
    expect(wrapDeg180(-190)).toBe(170);
    expect(wrapDeg180(720 + 45)).toBe(45);
    expect(wrapDeg180(359 - 1)).toBe(-2);
  });

  test('angular distance: along one axis it is the angle, and it is symmetric', () => {
    close(angularDistanceDeg({ yaw: 0, pitch: 0 }, { yaw: 15, pitch: 0 }), 15, 1e-9);
    close(angularDistanceDeg({ yaw: 0, pitch: 0 }, { yaw: 0, pitch: -8 }), 8, 1e-9);
    const a = { yaw: 30, pitch: 40 };
    const b = { yaw: -20, pitch: 10 };
    close(angularDistanceDeg(a, b), angularDistanceDeg(b, a), 1e-12);
    // At high pitch a yaw difference is a smaller arc (the great-circle distance, not a flat metric).
    expect(angularDistanceDeg({ yaw: 0, pitch: 60 }, { yaw: 20, pitch: 60 })).toBeLessThan(20);
    expect(angularDistanceDeg(a, a)).toBe(0);
  });
});

describe('courseRateDegS: the wrapped Δcourse / Δt between consecutive valid rows (plan §M1, rev1 I5)', () => {
  test('a right turn is positive (course is clockwise from north)', () => {
    expect(courseRateDegS(90, 0, 95, 1000)).toBe(5);
    expect(courseRateDegS(95, 1000, 90, 2000)).toBe(-5);
  });

  test('359° → 1° is +2°/s, and 1° → 359° is −2°/s', () => {
    expect(courseRateDegS(359, 0, 1, 1000)).toBe(2);
    expect(courseRateDegS(1, 0, 359, 1000)).toBe(-2);
  });

  test('scales by the time step, and refuses a non-positive or non-finite one', () => {
    expect(courseRateDegS(10, 0, 16, 2000)).toBe(3);
    expect(courseRateDegS(10, 1000, 16, 1000)).toBeNull();
    expect(courseRateDegS(10, 2000, 16, 1000)).toBeNull();
    expect(courseRateDegS(Number.NaN, 0, 16, 1000)).toBeNull();
  });
});
