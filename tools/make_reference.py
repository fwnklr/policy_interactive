"""Generate reference counterfactuals with the replication package's Python solver.

Reads the *exported* web data (web/data/, float32) so that the JavaScript solver
and this reference see identical inputs, builds the policy problems exactly as
irfoc/oc_solve.py does (single baseline, no vintage sequencing), solves them with
irfoc.modelsolver.ModelSolver, and writes tools/test/reference.json for
tools/test/check.html (open it via a local web server).

Usage:  python3 tools/make_reference.py [path/to/replication]
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

# The replication solver falls back to an unbounded least-squares search when its heuristic fails, which can
# run for minutes on infeasible problems (e.g. the first-difference rule with the ELB in the SW model).
# Cap it so such cases are reported as not converged instead of hanging.
_ls = _slcp.least_squares
_slcp.least_squares = lambda *a, **k: _ls(*a, max_nfev=25, **k)

DATA = os.path.join(REPO, "web", "data")
OUT = os.path.join(HERE, "test", "reference.json")

VARS = ["pic4", "rff", "lur", "lurnat", "xgap2", "hggdp", "lagrff", "lag4lur", "elb", "rstar", "pitarg"]
vj = {v: i for i, v in enumerate(VARS)}
J = len(VARS)
T_RULE_ELB = 80  # rules: ELB imposed over the first 80 quarters (as in oc_solve.py)
# Tighter than the replication default (1e-3): with 1e-3 the heuristic can accept
# different binding sets for ill-conditioned losses, so results depend on the seed.
LCP_TOL = 1e-7

RULES = {
    "T93": dict(rho=0.0, phi_pi=1.5, phi_u=1.0, phi_du=0.0),
    "inertialT99": dict(rho=0.85, phi_pi=0.225, phi_u=0.3, phi_du=0.0),
    "FD": dict(rho=1.0, phi_pi=0.5, phi_u=0.0, phi_du=0.5),
    "custom": dict(rho=0.5, phi_pi=0.8, phi_u=0.6, phi_du=0.3),
}
LOSSES = {
    "equal": dict(lam_u=1.0, lam_dr=1.0),
    "highpi": dict(lam_u=0.0, lam_dr=0.01),
    "custom": dict(lam_u=0.25, lam_dr=0.5),
}
VINTAGES = ["2015:Q2", "2020:Q2", "2021:Q4", "2023:Q4", "2026:Q2"]
# hggdp has no baseline in the database, so its reference "path" is the deviation from baseline.


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


def full_M(Mx, mvars, T):
    """(J, T, T) Jacobian incl. derived lags, as in oc_core.py."""
    M = np.zeros((J, T, T))
    for k, v in enumerate(mvars):
        M[vj[v]] = Mx[k]
    M[vj["lagrff"], 1:, :] = M[vj["rff"], :-1, :]
    M[vj["lag4lur"], 4:, :] = M[vj["lur"], :-4, :]
    return M


def full_Ybase(Bn, bvars, elb):
    nd = Bn.shape[1]
    Y = np.zeros((J, nd))
    for k, v in enumerate(bvars):
        if v == "hggdp":
            continue   # the reference reports the growth *response* (deviation from baseline), baseline = 0
        Y[vj[v]] = Bn[k]
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


def solve_rule(M, Yb, t0, T, p, use_elb):
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
    return ModelSolver().solve(Yb, M, P, Pi, t0 + 1, obc_options={"tol": LCP_TOL},
                              rng=np.random.default_rng(0))


def solve_commitment(M, Yb, t0, T, p, beta, use_elb):
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
    B = np.diag(beta ** np.arange(T))
    C = elb_rows()
    Mtil = mreshape(M, J * T, T)
    P = PolicyMap(y=Mtil.T @ mkron(B, W), u=Mtil.T @ mkron(B, C.T))
    Pi = PolicyMap(y=mkron(np.eye(T), C), u=mkron(np.eye(T), np.zeros((1, 1)))) if use_elb else None
    return ModelSolver().solve(Yb, M, P, Pi, t0 + 1, obc_options={"tol": LCP_TOL},
                              rng=np.random.default_rng(0))


def main():
    meta, Ms, B = load()
    T = meta["T"]
    labels = [v["label"] for v in meta["vintages"]]
    cases = []
    for model, Mx in Ms.items():
        M = full_M(Mx, meta["mvars"], T)
        for vlab in VINTAGES:
            n = labels.index(vlab)
            t0 = meta["vintages"][n]["t0"]
            for elb in (meta["elb"], 0.5):
                Yb = full_Ybase(B[n], meta["bvars"], elb)
                for use_elb in (False, True):
                    if elb != meta["elb"] and not use_elb:
                        continue
                    jobs = [("rule", k, p) for k, p in RULES.items()] + \
                           [("commitment", k, p) for k, p in LOSSES.items()]
                    for policy, name, p in jobs:
                        if policy == "rule":
                            Y, U, flag = solve_rule(M, Yb, t0, T, p, use_elb)
                        else:
                            Y, U, flag = solve_commitment(M, Yb, t0, T, p, meta["beta"], use_elb)
                        sl = slice(t0, t0 + T)
                        cases.append({
                            "model": model, "vintage": vlab, "policy": policy, "name": name,
                            "params": p, "use_elb": use_elb, "elb": elb,
                            "converged": bool(flag[0]),
                            "Y": {v: Y[vj[v], sl].tolist() for v in ["rff", "pic4", "lur", "lurnat", "xgap2", "hggdp"]},
                        })
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"T": T, "cases": cases}, f)
    bad = [c for c in cases if not c["converged"]]
    print(f"wrote {len(cases)} cases to {OUT}; not converged: {len(bad)}")
    for c in bad:
        print("  ", c["model"], c["vintage"], c["policy"], c["name"], c["elb"])


if __name__ == "__main__":
    main()
