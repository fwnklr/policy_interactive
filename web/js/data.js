// Load exported model Jacobians and SEP baselines (see tools/export_data.py).

import { mat } from "./linalg.js?v=__BUILD__";
import { prepareModel } from "./solver.js?v=__BUILD__";

// Replaced with the commit hash on deploy (see .github/workflows/pages.yml) so browsers never serve stale files.
const BUILD = "?v=__BUILD__";

async function fetchF32(url) {
  const r = await fetch(`${url}${BUILD}`);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Float32Array(await r.arrayBuffer());
}

export async function loadMeta(dir) {
  const r = await fetch(`${dir}/meta.json${BUILD}`);
  if (!r.ok) throw new Error(`${dir}/meta.json: ${r.status}`);
  return r.json();
}

const modelCache = new Map();

export async function loadModel(dir, meta, key) {
  if (!modelCache.has(key)) {
    const info = meta.models.find((m) => m.key === key);
    const p = fetchF32(`${dir}/${info.file}`).then((raw) => {
      const T = meta.T, Mraw = {};
      meta.mvars.forEach((v, k) => {
        Mraw[v] = mat(T, T, Float64Array.from(raw.subarray(k * T * T, (k + 1) * T * T)));
      });
      return prepareModel(T, Mraw, meta.beta);
    });
    modelCache.set(key, p);
  }
  return modelCache.get(key);
}

// Returns an array (one per vintage) of { rff, pic4, lur, lurnat, rstar, pitarg }.
export async function loadBaselines(dir, meta) {
  const raw = await fetchF32(`${dir}/${meta.baselines_file}`);
  const nv = meta.bvars.length, nd = meta.dates.length;
  return meta.vintages.map((_, n) => {
    const b = {};
    meta.bvars.forEach((v, k) => {
      const off = (n * nv + k) * nd;
      b[v] = Float64Array.from(raw.subarray(off, off + nd));
    });
    return b;
  });
}
