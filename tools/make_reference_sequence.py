"""Generate reference *sequences* of counterfactuals with the replication package's general-purpose
solver, for validating web/js/solver.js's createSequenceRunner (sequential/recursive updating across
several SEP-consistent projections -- Hebden & Winkler, Section 5).

Unlike tools/make_reference.py (one baseline, no vintage sequencing), this calls
irfoc.modelsolver.ModelSolver.solve() with the FULL (J, Nd, N) baseline stack and a t0 vector, which is
exactly modelsolver2.m's recursive revision scheme, unabridged and already validated against MATLAB by
the replication package itself. createSequenceRunner.step() is a from-scratch JS port that collapses that
same J*T-dimensional algebra to the T x T blocks used elsewhere on this site (see the derivation notes in
web/js/solver.js); this script gives an independent, general-purpose check of that port for N > 1 steps,
the one thing tools/make_reference.py cannot exercise (it only ever solves N = 1).

Usage:  python3 tools/make_reference_sequence.py [path/to/replication]
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

from irfoc.linalg_utils import block_diag, mkron, mreshape  # noqa: E402
from irfoc.modelsolver import ModelSolver, PolicyMap  # noqa: E402
import irfoc.solve_lcp as _slcp  # noqa: E402

# The replication solver falls back to an unbounded least-squares search when its heuristic fails,
# which can run for minutes on infeasible problems (e.g. the Smets-Wouters model, first-difference
# rule, with the ELB at 0.5). Cap it so such cases are reported as not converged instead of hanging
# (see tools/make_reference.py, which does the same for single-vintage cases).
_ls = _slcp.least_squares
_slcp.least_squares = lambda *a, **k: _ls(*a, max_nfev=25, **k)

DATA = os.path.join(REPO, "web", "data")
OUT = os.path.join(HERE, "test", "reference_sequence.json")

VARS = ["pic4", "rff", "lur", "lurnat", "xgap2", "hggdp", "lagrff", "lag4lur", "elb", "rstar", "pitarg"]
vj = {v: i for i, v in enumerate(VARS)}
J = len(VARS)
T_RULE_ELB = 80
LCP_TOL = 1e-7   # see tools/make_reference.py: the replication default (1e-3) is seed-dependent

RULES = {
    "T93": dict(rho=0.0, phi_pi=1.5, phi_u=1.0, phi_du=0.0),
    "FD": dict(rho=1.0, phi_pi=0.5, phi_u=0.0, phi_du=0.5),
}
LOSSES = {
    "equal": dict(lam_u=1.0, lam_dr=1.0),
    "highpi": dict(lam_u=0.0, lam_dr=0.01),
}

# Sequences of vintage LABELS (chronological), exercising: a short run, one crossing the old
# covid/non-covid pool boundary with a gap, and one starting outside the covid era.
SEQUENCES = {
    "short4": ["2020:Q2", "2020:Q3", "2020:Q4", "2021:Q1"],
    "gap6": ["2015:Q2", "2016:Q1", "2017:Q3", "2019:Q4", "2020:Q2", "2021:Q4"],
    "precovid3": ["2015:Q2", "2015:Q3", "2015:Q4"],
}
TRACKED = ["rff", "pic4", "lur", "lurnat", "xgap2", "hggdp"]


def load():
    meta = json.load(open(os.path.join(DATA, "meta.json")))
    T = meta["T"]
    Ms = {}
    for m in meta["models"]:
        raw = np.fromfile(os.path.join(DATA, m["file"]), dtype="<f4").astype(float)
        Ms[m["key"]] = raw.reshape(len(meta["mvars"]), T, T)
    nb, nd = len(meta["vintages"]), len(meta["dates"])
    B = np.fromfile(os.path.join(DATA, meta["baselines_file"]), dtype="<f4").astype(float)
    return meta, Ms, B.reshape(nb, len(meta["bvars"]), nd)


def full_M(mkey, meta, Ms):
    M = np.zeros((J, meta["T"], meta["T"]))
    for k, v in enumerate(meta["mvars"]):
        M[vj[v]] = Ms[mkey][k]
    M[vj["lagrff"], 1:, :] = M[vj["rff"], :-1, :]
    M[vj["lag4lur"], 4:, :] = M[vj["lur"], :-4, :]
    return M


def full_Ybase(meta, B, n, elb):
    Nd = B.shape[2]
    Y = np.zeros((J, Nd))
    for k, v in enumerate(meta["bvars"]):
        Y[vj[v]] = B[n, k]
    Y[vj["lagrff"], 1:] = Y[vj["rff"], :-1]
    Y[vj["lagrff"], 0] = Y[vj["rff"], 0]
    Y[vj["lag4lur"], 4:] = Y[vj["lur"], :-4]
    Y[vj["lag4lur"], :4] = Y[vj["lur"], 0]
    Y[vj["elb"]] = elb
    return Y


def elb_rows():
    C = np.zeros((1, J))
    C[0, vj["rff"]] = 1
    C[0, vj["elb"]] = -1
    return C


def solve_sequence(meta, M, Ybase_stack, t0s, policy, name, p, use_elb):
    T = meta["T"]
    N = Ybase_stack.shape[2]
    if policy == "rule":
        A = np.zeros((1, J))
        A[0, vj["rff"]] = 1
        A[0, vj["lagrff"]] = -p["rho"]
        A[0, vj["rstar"]] = -(1 - p["rho"])
        A[0, vj["pitarg"]] = -(1 - p["rho"]) + p["phi_pi"]
        A[0, vj["pic4"]] = -p["phi_pi"]
        A[0, vj["lur"]] = p["phi_u"] + p["phi_du"]
        A[0, vj["lurnat"]] = -p["phi_u"]
        A[0, vj["lag4lur"]] = -p["phi_du"]
        P = PolicyMap(y=mkron(np.eye(T), A), u=mkron(np.eye(T), np.ones((1, 1))))
        Pi = None
        if use_elb:
            Pi = PolicyMap(y=block_diag(mkron(np.eye(T_RULE_ELB), elb_rows()),
                                        mkron(np.eye(T - T_RULE_ELB), np.zeros((1, J)))),
                           u=mkron(np.eye(T), np.zeros((1, 1))))
    else:
        W = np.zeros((J, J))
        W[vj["pic4"], vj["pic4"]] = 1
        W[vj["pitarg"], vj["pitarg"]] = 1
        W[vj["pic4"], vj["pitarg"]] = -2
        W[vj["lur"], vj["lur"]] = p["lam_u"]
        W[vj["lurnat"], vj["lurnat"]] = p["lam_u"]
        W[vj["lur"], vj["lurnat"]] = -2 * p["lam_u"]
        W[vj["rff"], vj["rff"]] = p["lam_dr"]
        W[vj["lagrff"], vj["lagrff"]] = p["lam_dr"]
        W[vj["rff"], vj["lagrff"]] = -2 * p["lam_dr"]
        W = 0.5 * (W + W.T)
        B = np.diag(meta["beta"] ** np.arange(T))
        C = elb_rows()
        Mtil = mreshape(M, J * T, T)
        P = PolicyMap(y=Mtil.T @ mkron(B, W), u=Mtil.T @ mkron(B, C.T))
        Pi = PolicyMap(y=mkron(np.eye(T), C), u=mkron(np.eye(T), np.zeros((1, 1)))) if use_elb else None
    Y, U, flags = ModelSolver().solve(Ybase_stack, M, P, Pi, t0s, obc_options={"tol": LCP_TOL},
                                       rng=np.random.default_rng(0))
    if N == 1:
        Y = Y[:, :, None]
    return Y, flags


def main():
    meta, Ms, B = load()
    labels = [v["label"] for v in meta["vintages"]]
    cases = []
    for model, Mx in [(m["key"], Ms[m["key"]]) for m in meta["models"]]:
        M = full_M(model, meta, Ms)
        for seqname, seqlabels in SEQUENCES.items():
            ns = [labels.index(l) for l in seqlabels]
            t0s = np.array([meta["vintages"][n]["t0"] + 1 for n in ns])
            for elb in (meta["elb"], 0.5):
                Ybase_stack = np.stack([full_Ybase(meta, B, n, elb) for n in ns], axis=2)
                for use_elb in (False, True):
                    if elb != meta["elb"] and not use_elb:
                        continue
                    jobs = [("rule", k, p) for k, p in RULES.items()] + \
                           [("commitment", k, p) for k, p in LOSSES.items()]
                    for policy, name, p in jobs:
                        Y, flags = solve_sequence(meta, M, Ybase_stack, t0s, policy, name, p, use_elb)
                        cases.append({
                            "model": model, "sequence": seqname, "vintages": seqlabels,
                            "policy": policy, "name": name, "params": p, "use_elb": use_elb, "elb": elb,
                            "converged": bool(np.all(flags)),
                            # final (last-vintage) accumulated path, full Nd-length, for every tracked var
                            "Y": {v: Y[vj[v], :, -1].tolist() for v in TRACKED},
                        })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"cases": cases}, f)
    bad = [c for c in cases if not c["converged"]]
    print(f"wrote {len(cases)} sequence cases to {OUT}; not converged: {len(bad)}")
    for c in bad:
        print("  ", c["model"], c["sequence"], c["policy"], c["name"], c["elb"])


if __name__ == "__main__":
    main()
