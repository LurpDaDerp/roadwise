#!/usr/bin/env python3
"""Generate the JS parity fixtures from the Python reference (READ-ONLY import).

    <venv-python> dms/tests/tools/gen_fixtures.py [--out DIR]

Imports `dms`, `tests/synthetic.py`, `tools/behavior_eval.py` and `tools/synth_streams.py`
from the deployment-stack repo without modifying anything there, runs the reference engines
and writes JSON fixtures the `node --test` suite replays against the JS port.

Conventions
-----------
* Every INPUT float is quantised with `%.12g` BEFORE it reaches the reference, so the JSON
  carries the exact doubles the reference saw and the JS port starts from identical bits.
* Every OUTPUT float is quantised with `%.12g` when dumped (<= 1e-12 relative); event dicts
  keep the reference's own `to_dict()` rounding (3 / 4 decimals) untouched.
* Non-finite floats become `null`.
* Frame columns are stored column-wise and run-length / constant / alias encoded.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import math
import sys
from pathlib import Path

import numpy as np

STACK = Path("/home/lurpd/DevelopmentWSL2/distracted-driving-research/deployment-stack")
sys.path.insert(0, str(STACK))
sys.path.insert(0, str(STACK / "tests"))
sys.path.insert(0, str(STACK / "tools"))

from dms.alerts import Event, EventType  # noqa: E402
from dms.calibration import ForwardReference, robust_mode  # noqa: E402
from dms.config import DmsConfig  # noqa: E402
from dms.drowsiness import DrowsinessTracker  # noqa: E402
from dms.features import compute_features, head_angles  # noqa: E402
from dms.gaze_inputs import (  # noqa: E402
    camera_context, eye_aspect_ratios, eye_center_and_iod, eye_visibility, iris_x_in_eye,
    landmark_validity, mirror_cloud, mirror_context, mirror_validity, mouth_aspect_ratio,
    row_statistics, weak3d_cloud,
)
from dms.monitor import DriverMonitor  # noqa: E402
from dms.util import (  # noqa: E402
    BucketWindowSum, CausalMedian, CausalMedian as _CM, DecayingHistogram1D, DecayingHistogram2D,
    EventCounter, TimeWindowSum, angles_to_vector, angular_distance_deg, head_direction,
    reference_rotation, relative_angles, unit, vector_to_angles, wrap_deg,
)
import behavior_eval as BE  # noqa: E402
import synth_streams as S  # noqa: E402
from synthetic import SyntheticDriver  # noqa: E402

REPO = Path(__file__).resolve().parents[3]          # the app repo root
OUT = REPO / "dms/tests/fixtures"
MODELS = STACK / "models"


# --------------------------------------------------------------------------- quantisation
VALUE_DIGITS = 8    # inputs other than timestamps: shorter JSON, identical doubles on both sides
TIME_DIGITS = 12    # timestamps keep their resolution (dt must stay regular at t ~ 400 s)


def q(x, digits: int = 12):
    """Quantise a float to `digits` significant decimals (idempotent, round-trip exact)."""
    v = float(x)
    if not math.isfinite(v):
        return v
    return float(f"{v:.{digits}g}")


def qa(values, digits: int = 12):
    return [q(v, digits) for v in np.asarray(values, dtype=np.float64).reshape(-1)]


def jnum(x):
    """JSON-safe float: non-finite -> None."""
    if x is None:
        return None
    v = float(x)
    return v if math.isfinite(v) else None


def jout(x, digits: int = 12):
    return jnum(None if x is None else q(x, digits))


def jlist(values, digits: int = 12):
    return [jout(v, digits) for v in values]


# --------------------------------------------------------------------------- column coding
def encode_column(values, known: dict):
    """const / alias / run-length / raw, whichever is smaller."""
    if not values:
        return []
    first = values[0]
    if all(v == first for v in values):
        return {"const": first, "n": len(values)}
    for name, other in known.items():
        if other == values:
            return {"same": name}
    runs = []
    for v in values:
        if runs and runs[-1][0] == v:
            runs[-1][1] += 1
        else:
            runs.append([v, 1])
    if 2 * len(runs) < len(values):
        return {"runs": runs}
    return values


def encode_frames(columns: dict) -> dict:
    out: dict = {}
    raw: dict = {}
    for name, values in columns.items():
        out[name] = encode_column(values, raw)
        raw[name] = values
    return out


def write(path: Path, payload) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    path.write_text(text + "\n", encoding="utf-8", newline="\n")
    return path


# --------------------------------------------------------------------------- landmark frames
def make_face(rng, *, outside: int = 0):
    """A plausible 478-landmark face: eyes on a line, irises inside the eyes, mouth below."""
    lm = rng.uniform(0.25, 0.75, size=(478, 3))
    lm[:, 2] = rng.uniform(-0.05, 0.05, size=478)
    cx, cy = rng.uniform(0.42, 0.58), rng.uniform(0.40, 0.55)
    half = rng.uniform(0.10, 0.16)              # half interocular distance
    tilt = rng.uniform(-0.05, 0.05)
    ew = 0.42 * half                            # eye corner half width
    for sign, outer, inner, upper, lower, brow, iris, ear_pts in (
        (-1.0, 33, 133, 159, 145, 105, 468, (33, 160, 158, 133, 153, 144)),
        (+1.0, 263, 362, 386, 374, 334, 473, (362, 385, 387, 263, 373, 380)),
    ):
        ox, oy = cx + sign * half, cy + sign * tilt * half
        ix, iy = cx + sign * (half - 2.0 * ew), cy + sign * tilt * (half - 2.0 * ew)
        lm[outer] = (ox, oy, rng.uniform(-0.02, 0.02))
        lm[inner] = (ix, iy, rng.uniform(-0.02, 0.02))
        mx, my = 0.5 * (ox + ix), 0.5 * (oy + iy)
        lid = rng.uniform(0.12, 0.45) * ew      # lid opening
        lm[upper] = (mx, my - lid, 0.0)
        lm[lower] = (mx, my + lid, 0.0)
        lm[brow] = (mx, my - 3.0 * ew, 0.0)
        pupil = rng.uniform(-0.35, 0.35) * ew
        lm[iris] = (mx + pupil, my + rng.uniform(-0.2, 0.2) * lid, 0.0)
        for k in range(1, 5):                   # the iris ring
            ang = 2.0 * math.pi * k / 4.0
            lm[iris + k] = (lm[iris][0] + 0.3 * ew * math.cos(ang), lm[iris][1] + 0.3 * ew * math.sin(ang), 0.0)
        p1, p2, p3, p4, p5, p6 = ear_pts
        lm[p2] = (mx - 0.45 * ew, my - lid, 0.0)
        lm[p3] = (mx + 0.45 * ew, my - lid, 0.0)
        lm[p6] = (mx - 0.45 * ew, my + lid, 0.0)
        lm[p5] = (mx + 0.45 * ew, my + lid, 0.0)
    mouth_y = cy + 1.6 * half
    open_mm = rng.uniform(0.02, 0.5) * half
    lm[78] = (cx - 0.55 * half, mouth_y, 0.0)
    lm[308] = (cx + 0.55 * half, mouth_y, 0.0)
    lm[13] = (cx, mouth_y - 0.5 * open_mm, 0.0)
    lm[14] = (cx, mouth_y + 0.5 * open_mm, 0.0)
    for k in range(outside):                    # a few landmarks placed outside the image
        idx = int(rng.integers(200, 460))
        lm[idx] = (rng.uniform(1.01, 1.4) if k % 2 == 0 else rng.uniform(-0.4, -0.01),
                   rng.uniform(-0.3, 1.3), 0.0)
    return np.round(lm, 6)                       # exact short decimals: identical doubles in JS


def gaze_inputs_fixture(out_dir: Path) -> list[Path]:
    rng = np.random.default_rng(20260918)
    perm = np.load(MODELS / "mediapipe_mirror_permutation_478.npy").astype(np.int64)
    written = [write(out_dir / "mirror_permutation_478.json", [int(v) for v in perm])]
    cases = []
    for k in range(20):
        width = int(rng.choice([640, 800, 1280, 480]))
        height = int(rng.choice([480, 800, 720, 640]))
        focal = float(q(rng.uniform(0.6, 1.3), 9))
        lm = make_face(rng, outside=0 if k < 14 else int(rng.integers(1, 6)))
        cloud = weak3d_cloud(lm, width, height)
        ctx3 = camera_context(lm, width, height, focal)
        validity = landmark_validity(lm)
        center, iod = eye_center_and_iod(lm, width, height)
        ear_r, ear_l = eye_aspect_ratios(cloud)
        vis = eye_visibility(cloud)
        case = {
            "landmarks": [[float(v) for v in p] for p in lm],
            "width": width, "height": height, "focal_scale": focal,
            "cloud": jlist(cloud.reshape(-1)),
            "context3": jlist(ctx3),
            "validity": [int(v) for v in validity],
            "row_statistics": jlist(row_statistics(cloud)),
            "iris_x_in_eye": jout(iris_x_in_eye(cloud)),
            "eye_aspect_ratios": [jout(ear_r), jout(ear_l)],
            "mouth_aspect_ratio": jout(mouth_aspect_ratio(cloud)),
            "eye_visibility": [jout(vis[0]), jout(vis[1])],
            "eye_center": jlist(center),
            "iod": jout(iod),
        }
        if k < 4:      # the mirror helpers on a few cases (the arrays are large)
            case["mirror_cloud"] = jlist(mirror_cloud(cloud, perm).reshape(-1))
            case["mirror_context"] = jlist(mirror_context(np.concatenate([ctx3, [0.3, -0.02, -0.21, -0.9]])))
            case["mirror_validity"] = [int(v) for v in mirror_validity(validity, perm)]
        cases.append(case)
    written.append(write(out_dir / "gaze_inputs_cases.json", {"cases": cases}))

    # subject statistic tracker
    tracker_rng = np.random.default_rng(7)
    training_mean = [0.3145948052406311, -0.022462697699666023, -0.21199138462543488, -0.9008664488792419]
    from dms.gaze_inputs import SubjectStatisticTracker
    tracker = SubjectStatisticTracker(training_mean, warmup=30, window_s=120.0)
    pushes, currents = [], []
    for i in range(400):
        s = [q(training_mean[j] + tracker_rng.normal(0, 0.01)) for j in range(4)]
        if i % 37 == 5:
            s[1] = float("nan")
        pushes.append([None if not math.isfinite(v) else v for v in s])
        cur = tracker.push(np.asarray(s, dtype=np.float64), q(i / 30.0))
        currents.append(jlist(cur))
    written.append(write(out_dir / "gaze_inputs_stats_tracker.json", {
        "training_mean": training_mean, "warmup": 30, "window_s": 120.0,
        "t": [q(i / 30.0) for i in range(400)], "pushes": pushes, "current": currents,
    }))

    # ONNX bundle parity case (the app runtime self-test)
    with np.load(MODELS / "gaze_direct.parity.npz") as case:
        payload = {k: [float(f"{float(v):.9g}") for v in np.asarray(case[k]).reshape(-1)]
                   for k in ("cloud", "context", "validity", "gaze", "rotation")}
        payload["shapes"] = {k: list(np.asarray(case[k]).shape) for k in ("cloud", "context", "validity", "gaze", "rotation")}
    written.append(write(out_dir / "onnx_parity.json", payload))
    return written


def features_fixture(out_dir: Path) -> list[Path]:
    rng = np.random.default_rng(424242)
    cases = []
    for k in range(20):
        width = int(rng.choice([640, 800, 1280]))
        height = int(rng.choice([480, 800, 720]))
        lm = make_face(rng, outside=0 if k < 14 else int(rng.integers(1, 6)))
        cloud = weak3d_cloud(lm, width, height)
        validity = landmark_validity(lm)
        # a random rotation matrix (QR of a Gaussian), quantised so JS starts from the same bits
        a = rng.normal(size=(3, 3))
        qm, r = np.linalg.qr(a)
        qm = qm * np.sign(np.diag(r))
        if np.linalg.det(qm) < 0:
            qm[:, 0] *= -1.0
        rot = np.asarray([[q(v) for v in row] for row in qm])
        rotation = None if k == 19 else rot
        f = compute_features(q(k * 0.37), lm, width, height, cloud, validity, rotation)
        entry = {
            "t": q(k * 0.37), "width": width, "height": height,
            "landmarks": [[float(v) for v in p] for p in lm],
            "rotation": None if rotation is None else [float(v) for v in rot.reshape(-1)],
            "features": {
                "t": jout(f.t), "face_present": bool(f.face_present),
                "ear_right": jout(f.ear_right), "ear_left": jout(f.ear_left), "ear": jout(f.ear),
                "ear_near": jout(f.ear_near), "mar": jout(f.mar), "iris_x_in_eye": jout(f.iris_x_in_eye),
                "iris_y_in_aperture": jout(f.iris_y_in_aperture), "aperture": jout(f.aperture),
                "stats": jlist(f.stats), "eye_visibility": [jout(f.eye_visibility[0]), jout(f.eye_visibility[1])],
                "in_frame_fraction": jout(f.in_frame_fraction), "eye_center": jlist(f.eye_center),
                "iod": jout(f.iod), "head_dir": None if f.head_dir is None else jlist(f.head_dir),
                "head_yaw": jout(f.head_yaw), "head_pitch": jout(f.head_pitch), "head_roll": jout(f.head_roll),
            },
        }
        if rotation is not None:
            d, yaw, pitch, roll = head_angles(rot)
            entry["head_angles"] = {"dir": jlist(d), "yaw": jout(yaw), "pitch": jout(pitch), "roll": jout(roll)}
        cases.append(entry)
    return [write(out_dir / "features_cases.json", {"cases": cases})]


# --------------------------------------------------------------------------- util fixtures
def util_fixture(out_dir: Path) -> list[Path]:
    rng = np.random.default_rng(99)
    payload: dict = {}

    # --- 1-D histogram
    h = DecayingHistogram1D(-0.2, 0.6, 0.0025, 30.0)
    adds, probes = [], []
    for i in range(400):
        x = q(float(rng.normal(0.2, 0.08)))
        t = q(i / 15.0)
        w = q(float(rng.uniform(0.02, 0.09)))
        if i % 53 == 7:
            x = float("nan")
        adds.append([jnum(x), t, w])
        h.add(x, t, w)
        probes.append([jout(h.mass()), jout(h.quantile(0.02)), jout(h.quantile(0.5)), jout(h.quantile(0.95))])
    payload["hist1d"] = {"lo": -0.2, "hi": 0.6, "bin": 0.0025, "tau": 30.0, "adds": adds, "probes": probes}

    # a histogram that renormalises (long gaps) and one that stays empty
    h2 = DecayingHistogram1D(0.0, 0.8, 0.005, 2.0)
    adds2, probes2 = [], []
    for i in range(60):
        t = q(i * 1.7)
        x = q(0.3 + 0.001 * i)
        adds2.append([x, t, 1.0])
        h2.add(x, t, 1.0)
        probes2.append([jout(h2.mass()), jout(h2.median()), jout(h2.quantile(0.98))])
    payload["hist1d_decay"] = {"lo": 0.0, "hi": 0.8, "bin": 0.005, "tau": 2.0, "adds": adds2, "probes": probes2}

    # --- 2-D histogram + robust_mode
    cfg = DmsConfig().calibration
    g = DecayingHistogram2D(cfg.yaw_range, cfg.pitch_range, cfg.bin_deg, cfg.tau_long_s)
    adds3, probes3 = [], []
    for i in range(900):
        x = q(float(rng.normal(6.0, 4.0)))
        y = q(float(rng.normal(-3.0, 3.0)))
        t = q(i / 15.0)
        w = q(float(rng.uniform(0.03, 0.07)))
        if i % 101 == 3:
            x, y = q(-45.0 + float(rng.normal(0, 2))), q(20.0 + float(rng.normal(0, 2)))
        adds3.append([x, y, t, w])
        g.add(x, y, t, w)
        if i % 25 == 24:
            m = g.mode(cfg.smooth_sigma_bins)
            rm = robust_mode(g.counts, g.x0, g.y0, g.bin, cfg.search_sigma_deg, cfg.refine_radius_deg)
            probes3.append({
                "i": i, "mass": jout(g.mass()),
                "mode": None if m is None else jlist(m),
                "robust_mode": None if rm is None else jlist(rm),
                "mass_within": jout(g.mass_within(6.0, -3.0, cfg.concentration_radius_deg)),
                "smoothed_sum": jout(float(g.smoothed(cfg.smooth_sigma_bins).sum())),
            })
    payload["hist2d"] = {
        "x_range": list(cfg.yaw_range), "y_range": list(cfg.pitch_range), "bin": cfg.bin_deg,
        "tau": cfg.tau_long_s, "smooth_sigma_bins": cfg.smooth_sigma_bins,
        "search_sigma_deg": cfg.search_sigma_deg, "refine_radius_deg": cfg.refine_radius_deg,
        "concentration_radius_deg": cfg.concentration_radius_deg, "adds": adds3, "probes": probes3,
    }

    # copy_from: a short-tau twin fed the same samples, then copied into a fresh long-tau one
    src = DecayingHistogram2D(cfg.yaw_range, cfg.pitch_range, cfg.bin_deg, cfg.tau_short_s)
    for x, y, t, w in adds3[:300]:
        src.add(x, y, t, w)
    dst = DecayingHistogram2D(cfg.yaw_range, cfg.pitch_range, cfg.bin_deg, cfg.tau_long_s)
    for x, y, t, w in adds3[:40]:
        dst.add(x, y, t, w)
    dst.copy_from(src)
    payload["hist2d_copy"] = {"n_src": 300, "n_dst": 40, "mass": jout(dst.mass()),
                              "mode": jlist(dst.mode(cfg.smooth_sigma_bins))}

    # --- causal median
    cm = CausalMedian(5)
    pushes, results = [], []
    for i in range(80):
        x = q(float(rng.normal(0, 3)))
        pushes.append(x)
        results.append(jout(cm.push(x)))
    payload["causal_median"] = {"n": 5, "pushes": pushes, "results": results}

    # --- time window sums
    tw = TimeWindowSum(30.0)
    ops = []
    for i in range(600):
        t = q(i / 10.0)
        v = q(float(rng.uniform(-1.0, 2.0)))
        dt = q(0.1 + float(rng.normal(0, 0.005)))
        tw.push(t, v, dt)
        ops.append({"t": t, "v": v, "dt": dt, "total": jout(tw.total(t)),
                    "signed": jout(tw.total(t, clamp=False)), "span": jout(tw.span())})
    payload["time_window_sum"] = {"window": 30.0, "ops": ops}

    bw = BucketWindowSum(180.0, 1.0)
    bops = []
    for i in range(3000):
        t = q(i / 15.0)
        a = q(float(rng.uniform(0, 0.07)))
        b = q(0.0667)
        bw.push(t, a, b)
        if i % 17 == 0:
            sa, sb = bw.totals(t)
            bops.append({"i": i, "t": t, "a": a, "b": b, "sa": jout(sa), "sb": jout(sb)})
        else:
            bops.append({"i": i, "t": t, "a": a, "b": b})
    payload["bucket_window_sum"] = {"window": 180.0, "bucket": 1.0, "ops": bops,
                                    "final": jlist(bw.totals(q(2999 / 15.0))), "expired": jlist(bw.totals(10000.0))}

    ec = EventCounter(30.0)
    eops = []
    for i in range(200):
        t = q(i * 0.37)
        ec.push(t)
        eops.append({"t": t, "count": ec.count(t)})
    payload["event_counter"] = {"window": 30.0, "ops": eops}

    # --- angles
    vecs = []
    for _ in range(40):
        v = rng.normal(size=3)
        v = [q(float(x)) for x in v]
        u = unit(np.asarray(v))
        yaw, pitch = vector_to_angles(np.asarray(v))
        vecs.append({"v": v, "unit": jlist(u), "yaw": jout(yaw), "pitch": jout(pitch),
                     "back": jlist(angles_to_vector(yaw, pitch)),
                     "reference_rotation": jlist(reference_rotation(np.asarray(v)).reshape(-1))})
    pairs = []
    for _ in range(40):
        a = [q(float(x)) for x in rng.normal(size=3)]
        b = [q(float(x)) for x in rng.normal(size=3)]
        pairs.append({"a": a, "b": b, "distance": jout(angular_distance_deg(np.asarray(a), np.asarray(b))),
                      "relative": jlist(relative_angles(np.asarray(a), np.asarray(b)))})
    rots = []
    for _ in range(20):
        m, r = np.linalg.qr(rng.normal(size=(3, 3)))
        m = m * np.sign(np.diag(r))
        m = np.asarray([[q(v) for v in row] for row in m])
        rots.append({"rotation": [float(v) for v in m.reshape(-1)], "head_dir": jlist(head_direction(m))})
    wraps = [{"a": q(float(x)), "wrapped": jout(wrap_deg(q(float(x))))}
             for x in rng.uniform(-900, 900, size=40)]
    edge = [-180.0, 180.0, 0.0, 360.0, -360.0, 179.9999, -0.0]
    wraps += [{"a": v, "wrapped": jout(wrap_deg(v))} for v in edge]
    payload["angles"] = {"vectors": vecs, "pairs": pairs, "rotations": rots, "wraps": wraps,
                         "degenerate": [{"v": [0.0, 0.0, 1.0], "reference_rotation": jlist(reference_rotation(np.asarray([0.0, 0.0, 1.0])).reshape(-1))},
                                        {"v": [0.0, 0.0, -1.0], "reference_rotation": jlist(reference_rotation(np.asarray([0.0, 0.0, -1.0])).reshape(-1))}]}

    # --- Event.to_dict rounding
    rounding = []
    for _ in range(60):
        t = q(float(rng.uniform(0, 500)))
        ts = q(t - float(rng.uniform(0, 5)))
        v = q(float(rng.uniform(0, 100)))
        e = Event(EventType.LONG_GLANCE, t, ts, value=v, detail="ZONE", extra={"class": "cabin"})
        rounding.append({"t": t, "t_start": ts, "value": v, "dict": e.to_dict()})
    for v in (0.0625, 0.1875, 2.5, -2.5, 1.0005, 0.00005, 123.4565, 1 / 3, 1e-9):
        e = Event(EventType.BLINK, v, v, value=v)
        rounding.append({"t": v, "t_start": v, "value": v, "dict": e.to_dict()})
    payload["event_rounding"] = rounding
    return [write(out_dir / "util_cases.json", payload)]


# --------------------------------------------------------------------------- frame recording
FEAT_FIELDS = ("ear_right", "ear_left", "ear", "ear_near", "mar", "iris_x_in_eye",
               "iris_y_in_aperture", "aperture", "in_frame_fraction", "iod",
               "head_yaw", "head_pitch", "head_roll")


def quantise_features(f):
    """Quantise every float of a FrameFeatures IN PLACE (before the reference sees it)."""
    f.t = q(f.t, TIME_DIGITS)
    d = VALUE_DIGITS
    for name in FEAT_FIELDS:
        setattr(f, name, q(getattr(f, name), d))
    f.stats = np.asarray([q(v, d) for v in np.asarray(f.stats).reshape(-1)], dtype=np.float64)
    f.eye_visibility = (q(f.eye_visibility[0], d), q(f.eye_visibility[1], d))
    f.eye_center = np.asarray([q(v, d) for v in np.asarray(f.eye_center).reshape(-1)], dtype=np.float64)
    if f.head_dir is not None:
        f.head_dir = np.asarray([q(v, d) for v in np.asarray(f.head_dir).reshape(-1)], dtype=np.float64)
    return f


def feature_columns(feats, columns=None):
    c = columns if columns is not None else {}
    c.setdefault("face_present", []).append(None)
    return c


def new_feat_columns():
    cols = {"t": [], "face_present": []}
    for name in FEAT_FIELDS:
        cols[name] = []
    for k in range(4):
        cols[f"stats{k}"] = []
    cols["eye_vis0"] = []
    cols["eye_vis1"] = []
    cols["eye_center0"] = []
    cols["eye_center1"] = []
    for k, axis in enumerate("xyz"):
        cols[f"head_dir_{axis}"] = []
    return cols


def push_feat(cols, f):
    cols["t"].append(jnum(f.t))
    cols["face_present"].append(bool(f.face_present))
    for name in FEAT_FIELDS:
        cols[name].append(jnum(getattr(f, name)))
    st = np.asarray(f.stats).reshape(-1)
    for k in range(4):
        cols[f"stats{k}"].append(jnum(st[k]))
    cols["eye_vis0"].append(jnum(f.eye_visibility[0]))
    cols["eye_vis1"].append(jnum(f.eye_visibility[1]))
    ec = np.asarray(f.eye_center).reshape(-1)
    cols["eye_center0"].append(jnum(ec[0]))
    cols["eye_center1"].append(jnum(ec[1]))
    for k, axis in enumerate("xyz"):
        cols[f"head_dir_{axis}"].append(None if f.head_dir is None else jnum(np.asarray(f.head_dir).reshape(-1)[k]))


OUT_SCALARS = ("t", "gaze_yaw", "gaze_pitch", "rel_left", "rel_up", "reference_yaw", "reference_pitch",
               "admitted_s", "concentration", "calib_weight", "head_yaw", "head_pitch", "head_dev_deg",
               "buffer_s", "offroad_30s", "glance_s", "prc", "openness", "perclos", "blink_rate_per_min",
               "blink_mean_duration_s", "closure_s", "drowsiness_score", "exposure_60s", "road_share_60s",
               "head_pitch_dev", "perclos_long", "latency_ms")
OUT_OTHER = ("face_present", "zone", "zone_kind", "confidence", "yawn_count", "yawn_active",
             "drowsiness_level", "glance_class", "offroad_glances_60s", "eyes_readable")


# these outputs are verbatim copies of an input field; the replay asserts them against the
# input columns instead of storing a second copy
OUT_FROM_INPUT = ("t", "head_yaw", "head_pitch", "face_present")


def new_out_columns():
    cols = {name: [] for name in OUT_SCALARS if name != "latency_ms" and name not in OUT_FROM_INPUT}
    for name in OUT_OTHER:
        if name in OUT_FROM_INPUT:
            continue
        cols[name] = []
    for axis in "xyz":
        cols[f"gaze_{axis}"] = []
    for name in ("q_face_present", "q_in_frame_fraction", "q_eyes_open", "q_vis0", "q_vis1", "q_head_speed", "q_usable"):
        cols[name] = []
    cols["active_alerts"] = []
    cols["frame"] = []
    return cols


def push_out(cols, out, index: int):
    d = out.to_dict()
    cols["frame"].append(index)
    for name in OUT_SCALARS:
        if name == "latency_ms" or name in OUT_FROM_INPUT:
            continue
        cols[name].append(jout(d[name]))
    for name in OUT_OTHER:
        if name in OUT_FROM_INPUT:
            continue
        cols[name].append(d[name])
    gaze = d["gaze"]
    for k, axis in enumerate("xyz"):
        cols[f"gaze_{axis}"].append(None if gaze is None else jout(gaze[k]))
    qd = d["quality"]
    cols["q_face_present"].append(bool(qd["face_present"]))
    cols["q_in_frame_fraction"].append(jout(qd["in_frame_fraction"]))
    cols["q_eyes_open"].append(bool(qd["eyes_open"]))
    cols["q_vis0"].append(jout(qd["eye_visibility"][0]))
    cols["q_vis1"].append(jout(qd["eye_visibility"][1]))
    cols["q_head_speed"].append(jout(qd["head_speed_deg_s"]))
    cols["q_usable"].append(bool(qd["usable"]))
    cols["active_alerts"].append(list(d["active_alerts"]))


class Recorder:
    """Feeds quantised frames to a DriverMonitor and records inputs / outputs / events."""

    def __init__(self, monitor: DriverMonitor, t_full: float | None = None):
        self.mon = monitor
        self.inputs = new_feat_columns()
        self.gaze = {"x": [], "y": [], "z": []}
        self.rotation_is_identity = True
        self.outs = new_out_columns()
        self.events = []
        self.voiced = []
        self.index = 0
        self.t_full = t_full

    def columns(self) -> dict:
        cols = dict(self.inputs)
        for axis in "xyz":
            cols[f"gaze_{axis}"] = self.gaze[axis]
        return cols

    def feed(self, t, gaze, rotation, feat):
        feat = quantise_features(feat)
        t = q(t, TIME_DIGITS)
        gaze = None if gaze is None else np.asarray([q(v, VALUE_DIGITS) for v in np.asarray(gaze).reshape(-1)], dtype=np.float64)
        if rotation is not None and not np.allclose(np.asarray(rotation), np.eye(3)):
            self.rotation_is_identity = False
        out = self.mon.process_prediction(t, gaze, rotation, feat)
        push_feat(self.inputs, feat)
        for k, axis in enumerate("xyz"):
            self.gaze[axis].append(None if gaze is None else jnum(gaze[k]))
        for e in out.events:
            self.events.append({"i": self.index, **e.to_dict()})
        if out.voiced is not None:
            self.voiced.append({"i": self.index, **out.voiced.to_dict()})
        full = self.t_full is None or t >= self.t_full
        if full:
            push_out(self.outs, out, self.index)
        self.index += 1
        return out

    def payload(self, columns=None, **extra):
        cols = self.columns() if columns is None else columns
        return {
            "frames": self.index,
            "inputs": encode_frames(cols),
            "rotation": "identity" if self.rotation_is_identity else "varies",
            "outputs": encode_frames({k: v for k, v in self.outs.items() if k != "frame"}),
            "output_frames": self.outs["frame"],
            "events": self.events,
            "voiced": self.voiced,
            **extra,
        }


class RecordingRun(BE.Run):
    """`tools/behavior_eval.Run` with every frame recorded (and quantised)."""

    def __init__(self, fps, seed=0, speed=None, blink_period_s=4.0):
        self.rec = None
        self._speed = speed
        super().__init__(fps, seed=seed, speed=speed, blink_period_s=blink_period_s)

    def seg(self, seconds, **kw):
        if self.rec is None:
            self.rec = Recorder(self.mon, t_full=BE.WARMUP_S)
        for _ in range(int(round(seconds * self.fps))):
            t = self.d.t
            k = {key: (v(t) if callable(v) else v) for key, v in kw.items()}
            if self.blink_period_s and "ear" not in k and k.get("eyes_open", True) and k.get("face", True) and self._in_blink(t):
                k["ear"] = 0.06
            tt, g, r, f = self.d.frame(**k)
            self.outs.append(self.rec.feed(tt, g, r, f))


def p_lap_stare(r):
    """A 10-s look at the lap: LONG_GLANCE then PROLONGED_STARE (limit + stare_after_s)."""
    r.seg(10.0)
    r.mark()
    r.seg(10.0, up=-40.0, head_follow=0.5)


def p_sunglasses_head_only(r):
    """The eyes stop being measurable (sunglasses): EYES_UNREADABLE, then the head rules."""
    nan = float("nan")
    r.seg(15.0, ear=nan)
    r.mark()
    r.seg(8.0, ear=nan, left=60.0, head_left=50.0)     # head turned away from the road
    r.seg(8.0, ear=nan, up=-40.0, head_up=-30.0)       # head down
    r.seg(5.0, ear=nan)


def monitor_fixtures(out_dir: Path) -> list[Path]:
    written = []
    negatives = {n: b for n, b in BE.NEGATIVES}
    positives = {p[0]: p for p in BE.POSITIVES}
    plan = [
        ("mirror_checks", negatives["mirror_checks"], 15.0, None),
        ("cluster_checks", negatives["cluster_checks"], 15.0, None),
        ("shoulder_checks", negatives["shoulder_checks"], 15.0, None),
        ("passenger_talk", negatives["passenger_talk"], 15.0, None),
        ("intersection_side_looks", negatives["intersection_side_looks"], 15.0, None),
        ("brief_phone_checks", negatives["brief_phone_checks"], 15.0, None),
        ("head_bobbing", negatives["head_bobbing"], 15.0, None),
        ("lap_look_3.8s", positives["lap_look_3.8s"][1], 15.0, None),
        ("texting_pattern", positives["texting_pattern"][1], 15.0, None),
        ("side_stare_13.5s", positives["side_stare_13.5s"][1], 15.0, None),
        ("side_stare_at_50kmh", positives["side_stare_at_50kmh"][1], 15.0, 50.0),
        ("passenger_stare", positives["passenger_stare"][1], 15.0, None),
        ("microsleep", positives["microsleep"][1], 30.0, None),
        ("sleep", positives["sleep"][1], 30.0, None),
        ("eyes_closed", positives["eyes_closed"][1], 30.0, None),
        ("nodding_off", positives["nodding_off"][1], 30.0, None),
        ("drowsy_perclos", positives["drowsy_perclos"][1], 10.0, None),
        ("visual_time_sharing", positives["visual_time_sharing"][1], 15.0, None),
        ("driver_absent", positives["driver_absent"][1], 15.0, None),
        ("lap_stare_10s", p_lap_stare, 15.0, None),
        ("sunglasses_head_only", p_sunglasses_head_only, 15.0, None),
    ]
    # every scenario of a given frame rate starts with the IDENTICAL 150-s warm-up (same seed,
    # same `seg(WARMUP_S)` with no arguments), so the input frames of that prefix are stored once
    warmups: dict[str, dict] = {}
    for name, builder, fps, speed in plan:
        run = RecordingRun(fps, speed=speed)
        builder(run)
        cols = run.rec.columns()
        split = int(round(BE.WARMUP_S * fps))
        head = {k: v[:split] for k, v in cols.items()}
        tail = {k: v[split:] for k, v in cols.items()}
        key = f"{fps:g}hz"
        if key not in warmups:
            warmups[key] = head
            p = write(out_dir / f"monitor_warmup_{key}.json",
                      {"frames": split, "fps": fps, "warmup_s": BE.WARMUP_S, "seed": 0,
                       "columns": encode_frames(head),
                       "note": "the shared warm-up input frames of every monitor_* scenario at this frame rate"})
            written.append(p)
            print(f"  monitor_warmup_{key}: {split} frames -> {p.stat().st_size / 1e6:.2f} MB")
        elif warmups[key] != head:
            raise SystemExit(f"warm-up frames of {name} differ from the shared {key} prefix")
        payload = run.rec.payload(
            columns=tail,
            scenario=name, fps=fps, speed_kmh=speed, seed=0, blink_period_s=run.blink_period_s,
            warmup_s=BE.WARMUP_S, t_test=q(run.t_test, TIME_DIGITS),
            t_mark=None if run.t_mark is None else q(run.t_mark, TIME_DIGITS),
            inputs_prefix=f"monitor_warmup_{key}.json", prefix_frames=split,
            source="tools/behavior_eval.py + tests/synthetic.py",
        )
        written.append(write(out_dir / f"monitor_{name}.json", payload))
        print(f"  monitor_{name}: {run.rec.index} frames ({split} shared), {len(run.rec.events)} events, "
              f"{len(run.rec.voiced)} voiced -> {written[-1].stat().st_size / 1e6:.2f} MB")
    return written


def calibration_fixtures(out_dir: Path) -> list[Path]:
    """The scenarios of tests/test_calibration.py, driven through the full DriverMonitor."""
    written = []
    fps = 15.0

    def fresh():
        mon = DriverMonitor(DmsConfig(), gaze_model=False)
        return mon, Recorder(mon, t_full=None)

    def drive(rec, d, seconds, **kw):
        for _ in range(int(round(seconds * d.fps))):
            t, g, r, f = d.frame(**kw)
            rec.feed(t, g, r, f)

    # 1. persistent shift: the camera is bumped 12 deg after 90 s
    mon, rec = fresh()
    d = SyntheticDriver(fps=fps)
    drive(rec, d, 90.0)
    d.yaw0 += 12.0
    d.head_yaw0 += 12.0
    drive(rec, d, 150.0)
    written.append(write(out_dir / "monitor_calibration_persistent_shift.json",
                         rec.payload(scenario="calibration_persistent_shift", fps=fps, speed_kmh=None,
                                     source="tests/test_calibration.py::test_replaces_on_a_persistent_shift",
                                     t_test=None, t_mark=None)))

    # 2. a 70-s face gap, then a different driver sits down
    mon, rec = fresh()
    d = SyntheticDriver(fps=fps)
    drive(rec, d, 90.0)
    drive(rec, d, 70.0, face=False)
    d2 = SyntheticDriver(yaw0=-6.0, pitch0=2.0, head_yaw=-5.0, iris_x0=0.03, iris_y0=0.02, ear_open=0.27, seed=3, fps=fps)
    d2.t0 = d.t
    drive(rec, d2, 60.0)
    written.append(write(out_dir / "monitor_calibration_driver_change.json",
                         rec.payload(scenario="calibration_driver_change", fps=fps, speed_kmh=None,
                                     source="tests/test_calibration.py::test_fast_path_after_absence",
                                     t_test=None, t_mark=None)))

    # 3. camera moved (geometry trigger): the eye midpoint jumps after 60 s
    mon, rec = fresh()
    d = SyntheticDriver(fps=fps)
    drive(rec, d, 60.0)
    drive(rec, d, 20.0, center=(0.75, 0.4))
    written.append(write(out_dir / "monitor_calibration_camera_moved.json",
                         rec.payload(scenario="calibration_camera_moved", fps=fps, speed_kmh=None,
                                     source="tests/test_calibration.py::test_camera_moved_geometry_trigger",
                                     t_test=None, t_mark=None)))
    for p in written:
        print(f"  {p.name}: {p.stat().st_size / 1e6:.2f} MB")
    return written


# --------------------------------------------------------------------------- drowsiness streams
DSTATE_SCALARS = ("openness", "ear_open_baseline", "ear_closed_baseline", "closure_duration_s",
                  "blink_rate_per_min", "blink_mean_duration_s", "perclos", "perclos_long", "score")
DSTATE_OTHER = ("eyes_open", "closure_active", "long_blink_count", "perclos_valid", "perclos_long_valid",
                "yawn_active", "yawn_count_window", "nod_count_window", "level")


def drowsiness_fixtures(out_dir: Path) -> list[Path]:
    streams = [
        ("normal_driving", lambda: S.normal_driving(10.0, 180.0), 10.0, None, False),
        ("drowsy", lambda: S.drowsy(10.0, 320.0), 10.0, None, False),
        ("microsleep", lambda: S.microsleep(30.0, closure_s=4.0), 30.0, None, False),
        ("sunglasses", lambda: S.sunglasses(10.0, 90.0), 10.0, None, False),
        ("head_turn_closure", lambda: S.head_turn_closure(30.0), 30.0, "abs_head_yaw", False),
        ("look_down_lowered_lids", lambda: S.look_down_lowered_lids(10.0, 300.0), 10.0, None, True),
        ("nodding_off", lambda: S.nodding_off(30.0), 30.0, None, True),
        ("open_eye_head_dips", lambda: S.open_eye_head_dips(10.0, 240.0), 10.0, None, True),
        ("drowsy_then_recover", lambda: S.drowsy_then_recover(10.0), 10.0, None, True),
        ("single_bad_minute", lambda: S.single_bad_minute(10.0), 10.0, None, True),
    ]
    written = []
    for name, build, fps, head_turn, head_pitch in streams:
        stream = [quantise_features(f) for f in build()]
        tracker = DrowsinessTracker(DmsConfig())
        cols = new_feat_columns()
        args = {"head_turn_deg": [], "head_pitch_dev": []}
        outs = {k: [] for k in DSTATE_SCALARS}
        outs.update({k: [] for k in DSTATE_OTHER})
        events = []
        prev_pitch = None
        for i, f in enumerate(stream):
            turn = q(abs(f.head_yaw)) if head_turn == "abs_head_yaw" else None
            pitch_dev = prev_pitch if head_pitch else None
            st = tracker.update(f.t, f, turn, head_pitch_dev=pitch_dev)
            prev_pitch = f.head_pitch
            push_feat(cols, f)
            args["head_turn_deg"].append(jnum(turn))
            args["head_pitch_dev"].append(jnum(pitch_dev))
            for k in DSTATE_SCALARS:
                outs[k].append(jout(getattr(st, k)))
            for k in DSTATE_OTHER:
                v = getattr(st, k)
                outs[k].append(bool(v) if isinstance(v, (bool, np.bool_)) else v)
            for e in st.events:
                events.append({"i": i, **e.to_dict()})
        payload = {
            "stream": name, "fps": fps, "frames": len(stream),
            "head_turn_mode": head_turn, "head_pitch_dev_mode": bool(head_pitch),
            "inputs": encode_frames(cols), "args": encode_frames(args),
            "outputs": encode_frames(outs), "events": events,
            "source": "tools/synth_streams.py + tests/test_drowsiness.py::run",
        }
        written.append(write(out_dir / f"drowsiness_{name}.json", payload))
        print(f"  drowsiness_{name}: {len(stream)} frames, {len(events)} events -> {written[-1].stat().st_size / 1e6:.2f} MB")
    return written


# --------------------------------------------------------------------------- manifest
def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def app_repo_sha() -> str:
    try:
        head = (REPO / ".git")
        gitdir = Path(head.read_text(encoding="utf-8").split("gitdir:")[1].strip()) if head.is_file() else head
        ref = (gitdir / "HEAD").read_text(encoding="utf-8").strip()
        if ref.startswith("ref: "):
            name = ref[5:]
            common = gitdir
            while common.name in ("worktrees",) or (common.parent / "worktrees") == common:
                common = common.parent
            root = gitdir
            if "worktrees" in str(gitdir):
                root = Path(str(gitdir).split("/worktrees/")[0])
            loose = root / name
            if loose.is_file():
                return loose.read_text(encoding="utf-8").strip()
            packed = root / "packed-refs"
            if packed.is_file():
                for line in packed.read_text(encoding="utf-8").splitlines():
                    if line.endswith(" " + name):
                        return line.split(" ")[0]
            return f"unresolved:{name}"
        return ref
    except Exception as exc:  # pragma: no cover
        return f"unknown ({exc})"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=OUT)
    args = parser.parse_args()
    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    print("gaze inputs / features / util ...")
    written += gaze_inputs_fixture(out_dir)
    written += features_fixture(out_dir)
    written += util_fixture(out_dir)
    print("drowsiness streams ...")
    written += drowsiness_fixtures(out_dir)
    print("monitor scenarios ...")
    written += monitor_fixtures(out_dir)
    written += calibration_fixtures(out_dir)
    sources = ["dms/util.py", "dms/config.py", "dms/alerts.py", "dms/gaze_inputs.py", "dms/features.py",
               "dms/calibration.py", "dms/attention.py", "dms/drowsiness.py", "dms/monitor.py",
               "tests/synthetic.py", "tools/behavior_eval.py", "tools/synth_streams.py"]
    manifest = {
        "generated": _dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "generator": "dms/tests/tools/gen_fixtures.py",
        "app_repo_git_sha": app_repo_sha(),
        "reference_repo": str(STACK),
        "python": sys.version.split()[0],
        "numpy": np.__version__,
        "input_quantisation": "%.12g applied before the reference runs",
        "output_quantisation": "%.12g on dumped floats; event dicts keep to_dict()'s 3/4-decimal rounding",
        "reference_sha256": {name: sha256(STACK / name) for name in sources},
        "fixtures": [{"file": p.name, "bytes": p.stat().st_size} for p in written],
    }
    write(out_dir / "manifest.json", manifest)
    total = sum(p.stat().st_size for p in written) / 1e6
    print(f"wrote {len(written) + 1} files, {total:.1f} MB -> {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
