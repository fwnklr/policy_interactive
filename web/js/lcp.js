// Linear complementarity problem for the effective lower bound:
//   find u >= 0 with w = q + QQ u >= 0 and u'w = 0.
//
// Primary method: the worst-violation heuristic of solveLCP.m / solve_lcp.py
// (guess a binding set, solve the induced equality system, move one period in
// or out of the set at random, weighted by the size of the violation).
// Fallback: Lemke's complementary pivoting algorithm.

import { lu, luSolve, subSquare } from "./linalg.js";

// Small seeded PRNG (mulberry32) so results are reproducible.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function solveBinding(QQ, q, tbind) {
  const n = q.length;
  const u = new Float64Array(n);
  const idx = [];
  for (let i = 0; i < n; i++) if (tbind[i]) idx.push(i);
  if (idx.length) {
    const S = subSquare(QQ, idx);
    for (let i = 0; i < S.a.length; i++) S.a[i] = -S.a[i];
    const F = lu(S);
    if (F.singular) return null;
    const ui = luSolve(F, Float64Array.from(idx, (i) => q[i]));
    idx.forEach((i, k) => { u[i] = ui[k]; });
  }
  return u;
}

function residual(QQ, q, u) {
  const n = q.length, w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = q[i];
    const ai = i * n;
    for (let j = 0; j < n; j++) if (u[j] !== 0) s += QQ.a[ai + j] * u[j];
    w[i] = s;
  }
  return w;
}

function heuristic(QQ, q, { tol, maxiter, seed }) {
  const n = q.length;
  const rand = rng(seed);
  const tbind = new Uint8Array(n);
  for (let it = 0; it < maxiter; it++) {
    const u = solveBinding(QQ, q, tbind);
    if (!u) return null;
    const w = residual(QQ, q, u);
    let minw = Infinity, minu = Infinity;
    for (let i = 0; i < n; i++) { minw = Math.min(minw, w[i]); minu = Math.min(minu, u[i]); }
    if (minw >= -tol && minu >= -tol) return u;

    let expand;
    if (minw < -tol && minu >= -tol) expand = true;
    else if (minw >= -tol && minu < -tol) expand = false;
    else expand = rand() >= 0.25;

    let dist = Array.from(expand ? w : u, (v) => Math.min(0, v + tol));
    let s = dist.reduce((a, b) => a + b, 0);
    if (s === 0) {
      expand = !expand;
      dist = Array.from(expand ? w : u, (v) => Math.min(0, v + tol));
      s = dist.reduce((a, b) => a + b, 0);
      if (s === 0) return null;
    }
    let r = rand() * s, k = 0;          // s < 0, dist <= 0: sample proportionally
    for (; k < n - 1; k++) { r -= dist[k]; if (dist[k] < 0 && r >= 0) break; }
    tbind[k] = expand ? 1 : 0;
  }
  return null;
}

// Lemke's algorithm with covering vector e (tableau form).
function lemke(QQ, q, { maxpiv = 50 * q.length } = {}) {
  const n = q.length;
  if (q.every((v) => v >= 0)) return new Float64Array(n);
  // Tableau rows: w - QQ u - e z0 = q ; columns: w(0..n-1) u(n..2n-1) z0(2n) rhs(2n+1)
  const cols = 2 * n + 2;
  const Tb = new Float64Array(n * cols);
  for (let i = 0; i < n; i++) {
    Tb[i * cols + i] = 1;
    for (let j = 0; j < n; j++) Tb[i * cols + n + j] = -QQ.a[i * n + j];
    Tb[i * cols + 2 * n] = -1;
    Tb[i * cols + 2 * n + 1] = q[i];
  }
  const basis = Int32Array.from({ length: n }, (_, i) => i);
  const pivot = (row, col) => {
    const pr = row * cols, pv = Tb[pr + col];
    for (let j = 0; j < cols; j++) Tb[pr + j] /= pv;
    for (let i = 0; i < n; i++) {
      if (i === row) continue;
      const f = Tb[i * cols + col];
      if (f === 0) continue;
      for (let j = 0; j < cols; j++) Tb[i * cols + j] -= f * Tb[pr + j];
    }
    const leaving = basis[row];
    basis[row] = col;
    return leaving;
  };
  let row = 0;
  for (let i = 1; i < n; i++) if (q[i] < q[row]) row = i;
  let leaving = pivot(row, 2 * n);
  for (let k = 0; k < maxpiv; k++) {
    const entering = leaving < n ? leaving + n : leaving - n;   // complement
    let best = -1, ratio = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Tb[i * cols + entering];
      if (d > 1e-12) {
        const r = Tb[i * cols + 2 * n + 1] / d;
        if (r < ratio - 1e-12 || (Math.abs(r - ratio) <= 1e-12 && basis[i] === 2 * n)) { ratio = r; best = i; }
      }
    }
    if (best < 0) return null;                                  // ray termination
    leaving = pivot(best, entering);
    if (leaving === 2 * n) {
      const u = new Float64Array(n);
      for (let i = 0; i < n; i++) if (basis[i] >= n && basis[i] < 2 * n) u[basis[i] - n] = Tb[i * cols + 2 * n + 1];
      return u;
    }
  }
  return null;
}

// Returns { u, converged, method }.
// method: "auto" (heuristic, then Lemke) or "lemke" (Lemke only; used in tests).
export function solveLCP(QQ, q, { tol = 1e-3, maxiter = 4 * q.length, seed = 1, method = "auto" } = {}) {
  const n = q.length;
  if (q.every((v) => v >= -tol)) return { u: new Float64Array(n), converged: true, method: "none" };
  const check = (u) => {
    if (!u) return false;
    const w = residual(QQ, q, u);
    return u.every((v, i) => v >= -tol && w[i] >= -tol);
  };
  let u = method === "lemke" ? null : heuristic(QQ, q, { tol, maxiter, seed });
  if (check(u)) return { u, converged: true, method: "heuristic" };
  u = lemke(QQ, q);
  if (check(u)) return { u, converged: true, method: "lemke" };
  return { u: u || new Float64Array(n), converged: false, method: "failed" };
}
