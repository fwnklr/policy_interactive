// Policy counterfactuals in sequence space for a single baseline.
//
// y = ybar + M x, where x are anticipated policy shocks in periods 0..T-1 of the
// projection. The policy (a simple rule or the commitment first-order
// conditions) pins down x through a T x T system G x = Pu u - c, where u >= 0
// is the multiplier on the ELB constraint rff - elb >= 0 (u = 0 without ELB).
// This is modelsolver2.m / modelsolver.py specialised to one vintage, with the
// J*T-dimensional algebra collapsed to T x T blocks.

import { mat, matmul, matTdiagMul, matvec, matTvec, lu, luSolve, rightDivide } from "./linalg.js";
import { solveLCP } from "./lcp.js";

export const T_RULE_ELB = 80;   // rules: ELB imposed over the first 80 quarters (as in the paper)
export const OUTPUT_VARS = ["rff", "pic4", "lur", "lurnat", "xgap2"];
// Variables without a baseline in the SEP database: only the deviation from baseline is reported.
export const DEVIATION_VARS = ["hggdp"];

function shiftRows(A, k) {
  const B = mat(A.r, A.c);
  B.a.set(A.a.subarray(0, (A.r - k) * A.c), k * A.c);
  return B;
}

function lincomb(terms, r, c) {
  const S = mat(r, c);
  for (const [w, A] of terms) {
    if (w === 0) continue;
    for (let i = 0; i < S.a.length; i++) S.a[i] += w * A.a[i];
  }
  return S;
}

function sub(a, b) { return a.map((v, i) => v - b[i]); }

// Model: { T, M: { pic4, rff, lur, lurnat } } with T x T matrices (M[t][s]).
export function prepareModel(T, Mraw, beta) {
  const M = { ...Mraw };
  M.lagrff = shiftRows(M.rff, 1);
  M.lag4lur = shiftRows(M.lur, 4);
  // Loss-term Jacobians: inflation gap, unemployment gap, change in the policy rate.
  const L = {
    pi: M.pic4,
    u: lincomb([[1, M.lur], [-1, M.lurnat]], T, T),
    dr: lincomb([[1, M.rff], [-1, M.lagrff]], T, T),
  };
  return { T, M, L, beta, grams: new Map() };
}

// Discount factors and Gram matrices depend on beta; cache a few values (slider dragging).
function grams(model, beta) {
  let g = model.grams.get(beta);
  if (!g) {
    const { L } = model;
    const disc = Float64Array.from({ length: model.T }, (_, t) => beta ** t);
    g = {
      disc,
      pi: matTdiagMul(L.pi, disc, L.pi),
      u: matTdiagMul(L.u, disc, L.u),
      dr: matTdiagMul(L.dr, disc, L.dr),
      PuC: matTdiagMul(model.M.rff, disc, identity(model.T)),   // M_rff' B
    };
    if (model.grams.size >= 12) model.grams.delete(model.grams.keys().next().value);
    model.grams.set(beta, g);
  }
  return g;
}

function identity(n) {
  const I = mat(n, n);
  for (let i = 0; i < n; i++) I.a[i * n + i] = 1;
  return I;
}

// Baseline paths over the projection window [t0, t0+T), incl. lags.
// base: { rff, pic4, lur, lurnat, rstar, pitarg } full-length Float arrays.
export function baselineWindow(base, t0, T) {
  const w = {};
  for (const k of Object.keys(base)) w[k] = Float64Array.from({ length: T }, (_, t) => base[k][t0 + t]);
  w.lagrff = Float64Array.from({ length: T }, (_, t) => base.rff[t0 + t - 1]);
  w.lag4lur = Float64Array.from({ length: T }, (_, t) => base.lur[t0 + t - 4]);
  return w;
}

function ruleSystem(model, yb, p) {
  const { T, M } = model;
  const { rho, phi_pi, phi_u, phi_du } = p;
  const a = { rff: 1, lagrff: -rho, pic4: -phi_pi, lur: phi_u + phi_du, lurnat: -phi_u, lag4lur: -phi_du };
  const G = lincomb(Object.entries(a).map(([v, w]) => [w, M[v]]), T, T);
  const c = new Float64Array(T);
  const kr = -(1 - rho), kp = -(1 - rho) + phi_pi;
  for (let t = 0; t < T; t++) {
    let s = kr * yb.rstar[t] + kp * yb.pitarg[t];
    for (const [v, w] of Object.entries(a)) s += w * yb[v][t];
    c[t] = s;
  }
  return { G, c, Tc: T_RULE_ELB, Pu: null };   // Pu = I (first Tc columns)
}

function commitmentSystem(model, yb, p) {
  const { T, L } = model;
  const g = grams(model, p.beta ?? model.beta);
  const disc = g.disc;
  const lam = { pi: 1, u: p.lam_u, dr: p.lam_dr };
  const G = lincomb(Object.entries(lam).map(([k, w]) => [w, g[k]]), T, T);
  const gap = { pi: sub(yb.pic4, yb.pitarg), u: sub(yb.lur, yb.lurnat), dr: sub(yb.rff, yb.lagrff) };
  const c = new Float64Array(T);
  for (const [k, w] of Object.entries(lam)) {
    if (w === 0) continue;
    const v = matTvec(L[k], gap[k].map((e, t) => e * disc[t]));
    for (let t = 0; t < T; t++) c[t] += w * v[t];
  }
  return { G, c, Tc: T, Pu: g.PuC };
}

// policy: { type: "rule", rho, phi_pi, phi_u, phi_du } | { type: "commitment", lam_u, lam_dr }
// opts:   { useElb, elb, seed, lcpTol }. lcpTol is tighter than the replication
//         default (1e-3), which lets ill-conditioned losses pick seed-dependent binding sets.
export function solve(model, yb, policy, { useElb = true, elb = 0.125, seed = 1, lcpTol = 1e-7, method = "auto" } = {}) {
  const { T, M } = model;
  const sys = policy.type === "rule" ? ruleSystem(model, yb, policy) : commitmentSystem(model, yb, policy);
  const F = lu(sys.G);
  if (F.singular) throw new Error("Policy system is singular for these parameters.");
  const x = luSolve(F, sys.c.map((v) => -v));
  let lcp = { converged: true, method: "none", bindingQuarters: 0 };

  if (useElb) {
    const { Tc } = sys;
    const Mr = mat(Tc, T, M.rff.a.slice(0, Tc * T));
    const H = rightDivide(Mr, F);                      // M_rff G^{-1}, first Tc rows
    const rx = matvec(Mr, x);
    const q = Float64Array.from({ length: Tc }, (_, t) => yb.rff[t] - elb + rx[t]);
    let QQ;
    if (sys.Pu) {
      const PuC = mat(T, Tc);
      for (let i = 0; i < T; i++) for (let j = 0; j < Tc; j++) PuC.a[i * Tc + j] = sys.Pu.a[i * T + j];
      QQ = matmul(H, PuC);
    } else {
      QQ = mat(Tc, Tc);
      for (let i = 0; i < Tc; i++) for (let j = 0; j < Tc; j++) QQ.a[i * Tc + j] = H.a[i * T + j];
    }
    const res = solveLCP(QQ, q, { seed, tol: lcpTol, method });
    lcp = { converged: res.converged, method: res.method, bindingQuarters: res.u.filter((v) => v > 0).length };
    let Puu = new Float64Array(T);
    if (sys.Pu) {
      for (let i = 0; i < T; i++) {
        let s = 0;
        for (let j = 0; j < Tc; j++) s += sys.Pu.a[i * T + j] * res.u[j];
        Puu[i] = s;
      }
    } else {
      Puu.set(res.u);
    }
    const dx = luSolve(F, Puu);
    for (let t = 0; t < T; t++) x[t] += dx[t];
  }

  const Y = {};
  for (const v of OUTPUT_VARS) {
    const Mx = matvec(M[v], x);
    Y[v] = Float64Array.from({ length: T }, (_, t) => yb[v][t] + Mx[t]);
  }
  const D = {};
  for (const v of DEVIATION_VARS) D[v] = matvec(M[v], x);
  return { Y, D, x, lcp };
}
