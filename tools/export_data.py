"""Export model IRF matrices and SEP baselines for the web app.

Reads the replication package (data/sep_data.mat and output/model_results/*.mat) (../../replication by default) and writes

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
MVARS = ["pic4", "rff", "lur", "lurnat", "xgap2", "hggdp"]
BVARS = ["rff", "pic4", "lur", "lurnat", "xgap2", "rstar", "pitarg"]
# GDP growth (annualized quarterly, %) is exported as a baseline too as soon as the SEP database carries it for
# every vintage exported; until then the web page shows the counterfactual growth response only.
OPTIONAL_BVARS = ["hggdp"]

MODELS = {
    "linver_mcapwp": {"file": "runmod_mcapwp_results.mat", "label": "FRB/US (LINVER)"},
    "dgs_fhp": {"file": "dgs_fhp_irfoc_1PC_results.mat", "label": "DGS-FHP"},
    "sw": {"file": "sw_results.mat", "label": "Smets\u2013Wouters (2007)"},
}

# Baselines: one database (data/sep_data.mat) with a per-vintage is_covid flag.  Vintage values collide
# across the two pools (2021.0 appears in both), so pools are told apart by the flag.  The pre-covid
# pool's 2021.0 entry is a realized-data path (used only as a plotting reference in the paper), not an
# SEP baseline, so it is dropped.
GROUPS = [(True, "SEP 2020\u20132023"), (False, "SEP 2014\u20132016")]


def dropped(v, is_covid):
    return (not is_covid) and abs(v - 2021.0) < 1e-9


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
    tb = load_tb_data(os.path.join(REPL, "data", "sep_data.mat"))
    dates = tb.dates
    keep = [n for n, v in enumerate(tb.vintages) if not dropped(v, bool(tb.is_covid[n]))]
    bvars = list(BVARS)
    for k in OPTIONAL_BVARS:
        if k in tb.varj and not np.isnan(tb.Ybase[tb.varj[k]][:, keep]).any():
            bvars.append(k)
        else:
            print(f"note: baseline variable '{k}' not (fully) in sep_data.mat; not exported")
    meta["bvars"] = bvars
    blocks, vintages = [], []
    for covid, group in GROUPS:
        for n, v in enumerate(tb.vintages):
            if bool(tb.is_covid[n]) != covid or dropped(v, covid):
                continue
            Y = np.stack([tb.Ybase[tb.varj[k], :, n] for k in bvars])
            assert not np.isnan(Y).any(), f"NaN in baseline {v} ({group})"
            blocks.append(Y)
            # 0-based index of the first simulated period (= vintage quarter)
            t0 = int(round((v - dates[0]) * 4))
            vintages.append({"label": quarter_label(v), "year": float(v), "group": group, "t0": t0})
    labels = [v["label"] for v in vintages]
    assert len(set(labels)) == len(labels), "duplicate vintage labels"
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
