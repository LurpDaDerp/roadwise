"""Fill the expected outputs of assets/vectors/onnx-parity.json from Python onnxruntime.

Run make-vectors.ts first (it writes the inputs). Then, in a throwaway virtual environment (never a
repo dependency):

    python -m venv <scratch>/ortvenv
    <scratch>/ortvenv/Scripts/pip install onnxruntime==1.30.0 numpy
    <scratch>/ortvenv/Scripts/python modules/dms-vision/scripts/make-onnx-vectors.py

The model is the canonical copy in assets/models (the same bytes as the native copies; the models
test pins the sha256). The session matches the app's: CPU, one intra-op thread, all graph
optimisations. Outputs are written at float32 precision.
"""

import json
import pathlib
import sys

import numpy as np
import onnxruntime as ort

ROOT = pathlib.Path(__file__).resolve().parents[3]
MODEL = ROOT / "assets" / "models" / "gaze_direct.onnx"
VECTOR = ROOT / "modules" / "dms-vision" / "assets" / "vectors" / "onnx-parity.json"

if ort.__version__ != "1.30.0":
    sys.exit(f"onnxruntime {ort.__version__} found; the app pins 1.30.0")

options = ort.SessionOptions()
options.intra_op_num_threads = 1
options.inter_op_num_threads = 1
options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
session = ort.InferenceSession(str(MODEL), sess_options=options, providers=["CPUExecutionProvider"])

text = VECTOR.read_text(encoding="utf-8")
vector = json.loads(text)
cases = []
for case in vector["inputs"]["cases"]:
    feeds = {
        "cloud": np.asarray(case["cloud"], dtype=np.float32).reshape(1, 478, 3),
        "context": np.asarray(case["context"], dtype=np.float32).reshape(1, 7),
        "validity": np.asarray(case["validity"], dtype=np.float32).reshape(1, 478),
    }
    gaze, rotation = session.run(["gaze", "rotation"], feeds)
    cases.append(
        {
            "gaze": [float(v) for v in np.asarray(gaze, dtype=np.float32).reshape(-1)],
            "rotation": [float(v) for v in np.asarray(rotation, dtype=np.float32).reshape(-1)],
        }
    )
vector["expected"] = {"cases": cases}
VECTOR.write_text(json.dumps(vector, separators=(",", ":"), ensure_ascii=False) + "\n", encoding="utf-8")
print(f"wrote {len(cases)} expected outputs to {VECTOR.relative_to(ROOT)}")
