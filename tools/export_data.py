"""Export model IRF matrices and SEP baselines for the web app.

Reads the replication package (../../replication by default) and writes

    web/data/meta.json            variable names, dates, vintages, file layout
    web/data/M_<model>.bin        float32, [var][t][s] for MVARS, T x T each
    web/data/baselines.bin        float32, [vintage][var][date] for BVARS

M[var][t][s] is the response of `var` in period t to an anticipated policy
shock that hits in period s (Stage-1 Dynare IRFs, truncated to T = 200, exactly
as in irfoc/oc_core.py).

Usage:  python3 tools/export_data.py [path/to/replication]
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
REPL = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(REPO, "..", "replication"))
sys.path.insert(0, os.path.join(REPL, "python"))

from irfoc.io_mat import load_dynare_results, load_tb_data  # noqa: E402

OUT = os.path.join(REPO, "web", "data")
T = 200
MVARS = ["pic4", "rff", "lur", "lurnat", "xgap2"]
BVARS = ["rff", "pic4", "lur", "lurnat", "xgap2", "rstar", "pitarg"]

MODELS = {
    "linver_mcapwp": {"file": "runmod_mcapwp_results.mat", "label": "FRB/US (LINVER)"},
    "dgs_fhp": {"file": "dgs_fhp_irfoc_1PC_results.mat", "label": "DGS-FHP"},
}

# (data file, group label, vintages to drop).  The 2021.0 entry in sep6_data.mat
# is a realized-data path used only as a plotting reference, not an SEP baseline.
BASELINE_SETS = [
    ("sep_covid_data.mat", "SEP 2020–2023", []),
    ("sep6_data.mat", "SEP 2014–2016", [2021.0]),
]


def quarter_label(x: float) -> str:
    y = int(np.floor(x + 1e-9))
    q = int(round((x - y) * 4)) + 1
    return f"{y}:Q{q}"


def export_models(meta):
    meta["models"] = []
    for key, m in MODELS.items():
        irfs = load_dynare_results(os.path.join(REPL, "output", "model_results", m["file"]))["oo_irfs"]
        M = np.zeros((len(MVARS), T, T))
        for j, v in enumerate(MVARS):
            for s in range(T):
                M[j, :, s] = irfs[f"{v}_epsfwrd{s}"][:T]
        fname = f"M_{key}.bin"
        M.astype("<f4").tofile(os.path.join(OUT, fname))
        meta["models"].append({"key": key, "label": m["label"], "file": fname})


def export_baselines(meta):
    dates = None
    blocks, vintages = [], []
    for fname, group, drop in BASELINE_SETS:
        tb = load_tb_data(os.path.join(REPL, "data", fname))
        if dates is None:
            dates = tb.dates
        assert np.array_equal(dates, tb.dates), "baseline files have different date grids"
        for n, v in enumerate(tb.vintages):
            if any(abs(v - d) < 1e-9 for d in drop):
                continue
            Y = np.stack([tb.Ybase[tb.varj[k], :, n] for k in BVARS])
            assert not np.isnan(Y).any()
            blocks.append(Y)
            # 0-based index of the first simulated period (= vintage quarter)
            t0 = int(round((v - dates[0]) * 4))
            vintages.append({"label": quarter_label(v), "year": float(v), "group": group, "t0": t0})
    np.stack(blocks).astype("<f4").tofile(os.path.join(OUT, "baselines.bin"))
    meta["dates"] = [float(d) for d in dates]
    meta["vintages"] = vintages


def main():
    os.makedirs(OUT, exist_ok=True)
    meta = {"T": T, "mvars": MVARS, "bvars": BVARS, "baselines_file": "baselines.bin",
            "elb": 0.125, "beta": 0.9963}
    export_models(meta)
    export_baselines(meta)
    with open(os.path.join(OUT, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(f"wrote {len(meta['models'])} models, {len(meta['vintages'])} baselines to {OUT}")


if __name__ == "__main__":
    main()
