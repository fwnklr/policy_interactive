// Dense linear algebra on row-major Float64Array matrices.
// A matrix is { r, c, a } with element (i, j) at a[i * c + j].

export function mat(r, c, a = new Float64Array(r * c)) {
  return { r, c, a };
}

export function matmul(A, B) {
  if (A.c !== B.r) throw new Error(`matmul: ${A.r}x${A.c} * ${B.r}x${B.c}`);
  const C = mat(A.r, B.c);
  const a = A.a, b = B.a, c = C.a, n = A.c, m = B.c;
  for (let i = 0; i < A.r; i++) {
    const ci = i * m;
    for (let k = 0; k < n; k++) {
      const aik = a[i * n + k];
      if (aik === 0) continue;
      const bk = k * m;
      for (let j = 0; j < m; j++) c[ci + j] += aik * b[bk + j];
    }
  }
  return C;
}

// A' * diag(d) * B  (d may be null for the identity)
export function matTdiagMul(A, d, B) {
  if (A.r !== B.r) throw new Error("matTdiagMul: row mismatch");
  const C = mat(A.c, B.c);
  const a = A.a, b = B.a, c = C.a, n = A.c, m = B.c;
  for (let k = 0; k < A.r; k++) {
    const dk = d ? d[k] : 1;
    const ak = k * n, bk = k * m;
    for (let i = 0; i < n; i++) {
      const s = a[ak + i] * dk;
      if (s === 0) continue;
      const ci = i * m;
      for (let j = 0; j < m; j++) c[ci + j] += s * b[bk + j];
    }
  }
  return C;
}

export function matvec(A, x) {
  const y = new Float64Array(A.r);
  for (let i = 0; i < A.r; i++) {
    let s = 0;
    const ai = i * A.c;
    for (let j = 0; j < A.c; j++) s += A.a[ai + j] * x[j];
    y[i] = s;
  }
  return y;
}

// A' * x
export function matTvec(A, x) {
  const y = new Float64Array(A.c);
  for (let i = 0; i < A.r; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    const ai = i * A.c;
    for (let j = 0; j < A.c; j++) y[j] += A.a[ai + j] * xi;
  }
  return y;
}

// LU factorization with partial pivoting of a square matrix (copied).
export function lu(A) {
  const n = A.r;
  if (A.c !== n) throw new Error("lu: matrix not square");
  const a = Float64Array.from(A.a);
  const piv = new Int32Array(n);
  let singular = false;
  for (let k = 0; k < n; k++) {
    let p = k, max = Math.abs(a[k * n + k]);
    for (let i = k + 1; i < n; i++) {
      const v = Math.abs(a[i * n + k]);
      if (v > max) { max = v; p = i; }
    }
    piv[k] = p;
    if (max === 0) { singular = true; continue; }
    if (p !== k) {
      for (let j = 0; j < n; j++) {
        const t = a[k * n + j]; a[k * n + j] = a[p * n + j]; a[p * n + j] = t;
      }
    }
    const akk = a[k * n + k];
    for (let i = k + 1; i < n; i++) {
      const f = (a[i * n + k] /= akk);
      if (f === 0) continue;
      for (let j = k + 1; j < n; j++) a[i * n + j] -= f * a[k * n + j];
    }
  }
  return { n, a, piv, singular };
}

// Solve A x = b given lu(A); b is a Float64Array (not modified).
export function luSolve(F, b) {
  const { n, a, piv } = F;
  const x = Float64Array.from(b);
  for (let k = 0; k < n; k++) {
    const p = piv[k];
    if (p !== k) { const t = x[k]; x[k] = x[p]; x[p] = t; }
  }
  for (let i = 0; i < n; i++) {
    let s = x[i];
    for (let j = 0; j < i; j++) s -= a[i * n + j] * x[j];
    x[i] = s;
  }
  for (let i = n - 1; i >= 0; i--) {
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= a[i * n + j] * x[j];
    x[i] = s / a[i * n + i];
  }
  return x;
}

// Solve A' x = b given lu(A).
export function luSolveT(F, b) {
  const { n, a, piv } = F;
  const x = Float64Array.from(b);
  for (let i = 0; i < n; i++) {        // U' z = b
    let s = x[i];
    for (let j = 0; j < i; j++) s -= a[j * n + i] * x[j];
    x[i] = s / a[i * n + i];
  }
  for (let i = n - 1; i >= 0; i--) {   // L' w = z
    let s = x[i];
    for (let j = i + 1; j < n; j++) s -= a[j * n + i] * x[j];
    x[i] = s;
  }
  for (let k = n - 1; k >= 0; k--) {   // undo row permutation
    const p = piv[k];
    if (p !== k) { const t = x[k]; x[k] = x[p]; x[p] = t; }
  }
  return x;
}

// X = B * A^{-1} for a (m x n) matrix B, given lu(A): rows solve A' x = b'.
export function rightDivide(B, F) {
  const X = mat(B.r, B.c);
  for (let i = 0; i < B.r; i++) {
    X.a.set(luSolveT(F, B.a.subarray(i * B.c, (i + 1) * B.c)), i * B.c);
  }
  return X;
}

// Principal submatrix A[idx, idx].
export function subSquare(A, idx) {
  const k = idx.length, S = mat(k, k);
  for (let i = 0; i < k; i++) {
    const ai = idx[i] * A.c;
    for (let j = 0; j < k; j++) S.a[i * k + j] = A.a[ai + idx[j]];
  }
  return S;
}
