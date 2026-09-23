import { loadMeta, loadModel, loadBaselines } from "./data.js";
import { solve, baselineWindow } from "./solver.js";
import { LinkedCharts } from "./chart.js";

const DATA_DIR = "data";
const HISTORY_Q = 8;   // quarters of data shown before the projection starts

const RULE_PRESETS = {
  T93: { label: "Taylor (1993)", rho: 0, phi_pi: 1.5, phi_u: 1, phi_du: 0 },
  T99: { label: "Inertial Taylor (1999)", rho: 0.85, phi_pi: 0.225, phi_u: 0.3, phi_du: 0 },
  FD: { label: "First difference", rho: 1, phi_pi: 0.5, phi_u: 0, phi_du: 0.5 },
};
const LOSS_PRESETS = {
  equal: { label: "Equal weights", lam_u: 1, lam_dr: 1 },
  inflation: { label: "Inflation focus", lam_u: 0, lam_dr: 0.01 },
};
const LAM_U_STOPS = [0, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 10];
const LAM_DR_STOPS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 4, 10];

const DEFAULT = {
  model: "linver_mcapwp", vintage: "2020:Q2", policy: "rule",
  rho: 0, phi_pi: 1.5, phi_u: 1, phi_du: 0,
  lam_u: 1, lam_dr: 1,
  elb_on: true, years: 6,
};

const $ = (id) => document.getElementById(id);
let meta, baselines, charts, state, pending = false, lastResult = null;
let mode = "cf";        // "cf" (counterfactual) or "edit" (baseline editing, solver off)
let edits = null;       // { vintage, base: {rff,pic4,lur,lurnat,rstar,pitarg}, dirty } working copy of a baseline
let dragOrig = null;
let brush = "2";       // "point" | quarters of the smoothing kernel (2 = 1 year, 6 = 3 years)
const EDIT_VARS = ["rff", "pic4", "lur", "xgap2"];   // variable behind each chart panel

// ---------- state <-> URL hash (shareable scenarios) ----------
function readHash() {
  const s = { ...DEFAULT };
  const q = new URLSearchParams(location.hash.slice(1));
  for (const [k, v] of q) {
    if (!(k in DEFAULT)) continue;
    if (typeof DEFAULT[k] === "number") { const x = Number(v); if (Number.isFinite(x)) s[k] = x; }
    else if (typeof DEFAULT[k] === "boolean") s[k] = v === "1";
    else s[k] = v;
  }
  if (!meta.models.some((m) => m.key === s.model)) s.model = DEFAULT.model;
  if (!meta.vintages.some((v) => v.label === s.vintage)) s.vintage = DEFAULT.vintage;
  if (!["rule", "commitment"].includes(s.policy)) s.policy = DEFAULT.policy;
  s.lam_u = nearest(LAM_U_STOPS, s.lam_u);
  s.lam_dr = nearest(LAM_DR_STOPS, s.lam_dr);
  return s;
}

function writeHash() {
  const q = new URLSearchParams();
  for (const k of Object.keys(DEFAULT)) {
    if (state[k] === DEFAULT[k]) continue;
    q.set(k, typeof state[k] === "boolean" ? (state[k] ? "1" : "0") : state[k]);
  }
  history.replaceState(null, "", q.toString() ? `#${q}` : location.pathname + location.search);
}

function nearest(stops, v) {
  return stops.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
}

// ---------- controls ----------
function buildControls() {
  const model = $("model");
  for (const m of meta.models) model.add(new Option(m.label, m.key));

  const vintage = $("vintage");
  const groups = {};
  for (const v of meta.vintages) {
    if (!groups[v.group]) {
      groups[v.group] = document.createElement("optgroup");
      groups[v.group].label = v.group;
    }
    groups[v.group].appendChild(new Option(v.label, v.label));
  }
  Object.values(groups).forEach((g) => vintage.appendChild(g));

  const presets = $("rule-presets");
  for (const [key, p] of Object.entries(RULE_PRESETS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.dataset.preset = key;
    b.addEventListener("click", () => set({ rho: p.rho, phi_pi: p.phi_pi, phi_u: p.phi_u, phi_du: p.phi_du }));
    presets.appendChild(b);
  }
  const lpresets = $("loss-presets");
  for (const [key, p] of Object.entries(LOSS_PRESETS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = p.label;
    b.dataset.preset = key;
    b.addEventListener("click", () => set({ lam_u: p.lam_u, lam_dr: p.lam_dr }));
    lpresets.appendChild(b);
  }

  model.addEventListener("change", () => set({ model: model.value }));
  vintage.addEventListener("change", () => set({ vintage: vintage.value }));
  document.querySelectorAll("input[name=policy]").forEach((r) =>
    r.addEventListener("change", () => set({ policy: r.value })));
  // Sliders: the label follows the thumb while dragging; the scenario is recomputed on release.
  const onRelease = (id, toValue) => {
    const el = $(id);
    el.addEventListener("input", () => { $(`${id}-out`).textContent = String(Number(toValue(el.value).toFixed(3))); });
    el.addEventListener("change", () => set({ [id]: toValue(el.value) }));
  };
  for (const k of ["rho", "phi_pi", "phi_u", "phi_du"]) onRelease(k, Number);
  $("lam_u").max = LAM_U_STOPS.length - 1;
  $("lam_dr").max = LAM_DR_STOPS.length - 1;
  onRelease("lam_u", (i) => LAM_U_STOPS[i]);
  onRelease("lam_dr", (i) => LAM_DR_STOPS[i]);
  $("elb_on").addEventListener("change", () => set({ elb_on: $("elb_on").checked }));
  $("years").addEventListener("change", () => set({ years: Number($("years").value) }));
  $("reset").addEventListener("click", () => { edits = null; setMode("cf"); set({ ...DEFAULT }); });
  document.querySelectorAll("input[name=mode]").forEach((r) =>
    r.addEventListener("change", () => setMode(r.value)));
  $("reset-base").addEventListener("click", () => { edits = null; ensureEdits(); renderEdit(); syncEditPanel(); });
  for (const k of ["pistar", "ustar", "lrrate"]) {
    $(k).addEventListener("change", () => setLevel(k, Number($(k).value)));
  }
  document.querySelectorAll("#brush-bar button").forEach((b) => b.addEventListener("click", () => {
    brush = b.dataset.brush;
    syncBrush();
  }));
  syncBrush();
  $("download").addEventListener("click", downloadCsv);
  $("copy-link").addEventListener("click", async () => {
    const b = $("copy-link");
    try {
      await navigator.clipboard.writeText(location.href);
      b.textContent = "Link copied";
    } catch {
      b.textContent = "Copy the address bar";
    }
    setTimeout(() => { b.textContent = "Copy link to this scenario"; }, 2000);
  });
}

function syncControls() {
  $("model").value = state.model;
  $("vintage").value = state.vintage;
  document.querySelectorAll("input[name=policy]").forEach((r) => { r.checked = r.value === state.policy; });
  $("rule-controls").hidden = state.policy !== "rule";
  $("loss-controls").hidden = state.policy !== "commitment";

  for (const k of ["rho", "phi_pi", "phi_u", "phi_du"]) {
    $(k).value = state[k];
    $(`${k}-out`).textContent = String(Number(state[k].toFixed(3)));
  }
  const match = (p) => ["rho", "phi_pi", "phi_u", "phi_du"].every((k) => Math.abs(p[k] - state[k]) < 1e-9);
  $("rule-presets").querySelectorAll("button").forEach((b) =>
    b.setAttribute("aria-pressed", match(RULE_PRESETS[b.dataset.preset])));
  $("rule-longrun").textContent = state.rho < 1
    ? `Long-run response: inflation ${(state.phi_pi / (1 - state.rho)).toFixed(2)}, unemployment gap ${(state.phi_u / (1 - state.rho)).toFixed(2)}`
    : "ρ = 1: the rule sets the change in the rate.";

  $("lam_u").value = LAM_U_STOPS.indexOf(state.lam_u);
  $("lam_dr").value = LAM_DR_STOPS.indexOf(state.lam_dr);
  $("lam_u-out").textContent = state.lam_u;
  $("lam_dr-out").textContent = state.lam_dr;
  $("loss-presets").querySelectorAll("button").forEach((b) => {
    const p = LOSS_PRESETS[b.dataset.preset];
    b.setAttribute("aria-pressed", p.lam_u === state.lam_u && p.lam_dr === state.lam_dr);
  });

  $("elb_on").checked = state.elb_on;
  $("years").value = state.years;
}

function set(patch) {
  if (patch.vintage && patch.vintage !== state.vintage && edits?.dirty &&
      !confirm("Changing the baseline discards your edits. Continue?")) {
    syncControls();
    return;
  }
  if (patch.vintage && patch.vintage !== state.vintage) edits = null;
  state = { ...state, ...patch };
  syncControls();
  writeHash();
  schedule();
}

// ---------- compute + render ----------
function schedule() {
  if (pending) return;
  pending = true;
  setTimeout(async () => {   // batches bursts of slider events; unlike rAF it also runs in background tabs
    pending = false;
    await run();
  }, 0);
}

async function run() {
  const s = state;
  const status = $("status");
  document.body.classList.add("busy");
  let model;
  try {
    model = await loadModel(DATA_DIR, meta, s.model);
  } catch (e) {
    status.textContent = `Could not load model data (${e.message}).`;
    return;
  }
  if (s !== state) return;   // superseded while loading

  const n = meta.vintages.findIndex((v) => v.label === s.vintage);
  const t0 = meta.vintages[n].t0;
  if (mode === "edit") {
    document.body.classList.remove("busy");
    ensureEdits();
    syncEditPanel();
    renderEdit();
    return;
  }
  const base = edits ? edits.base : baselines[n];
  const yb = baselineWindow(base, t0, meta.T);
  const policy = s.policy === "rule"
    ? { type: "rule", rho: s.rho, phi_pi: s.phi_pi, phi_u: s.phi_u, phi_du: s.phi_du }
    : { type: "commitment", lam_u: s.lam_u, lam_dr: s.lam_dr };

  let out;
  const t = performance.now();
  try {
    out = solve(model, yb, policy, { useElb: s.elb_on, elb: meta.elb });
  } catch (e) {
    status.textContent = `No solution for these settings: ${e.message}`;
    status.dataset.kind = "error";
    document.body.classList.remove("busy");
    return;
  }
  const ms = performance.now() - t;
  document.body.classList.remove("busy");

  const bad = Object.values(out.Y).some((a) => a.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e3));
  if (bad) {
    status.textContent = s.policy === "rule"
      ? "These settings produce an explosive path. Try a stronger response to inflation."
      : "These settings produce an explosive path. Try a larger rate-change weight.";
    status.dataset.kind = "error";
    return;
  }
  const bits = [];
  if (s.elb_on) {
    const q = out.lcp.bindingQuarters;
    bits.push(q ? `ELB binds in ${q} quarter${q > 1 ? "s" : ""} of the projection.` : "ELB does not bind.");
    if (!out.lcp.converged) bits.push("Warning: the ELB problem did not converge; results are approximate.");
  }
  if (edits?.dirty) bits.push("Using your edited baseline.");
  bits.push(`Computed in ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms.`);
  status.textContent = bits.join(" ");
  status.dataset.kind = out.lcp.converged ? "" : "error";

  lastResult = render(s, n, t0, base, out.Y);
}

function render(s, n, t0, base, Y) {
  const start = t0 - HISTORY_Q, H = 4 * s.years, end = t0 + H;
  const labels = [], idx = [];
  for (let i = start; i < end; i++) { idx.push(i); labels.push(quarterLabel(meta.dates[i])); }
  const markIndex = HISTORY_Q;
  // counterfactual starts at the last data point so the line departs from history
  const cf = (v) => idx.map((i) => (i < t0 - 1 ? null : i < t0 ? base[v][i] : Y[v][i - t0]));
  const bl = (v) => idx.map((i) => base[v][i]);
  const blLabel = edits?.dirty ? "Edited baseline" : "SEP baseline";
  const proj = (arr) => arr.map((v, k) => (k < markIndex ? null : v));

  const longrun = idx.map((i) => base.rstar[i] + base.pitarg[i]);
  const panels = [
    {
      series: [
        { label: "Long-run rate", values: proj(longrun), cls: "ref" },
        { label: blLabel, values: bl("rff"), cls: "base" },
        { label: "Counterfactual", values: cf("rff"), cls: "cf" },
      ],
      hlines: s.elb_on ? [{ y: meta.elb, label: "ELB" }] : [],
    },
    {
      series: [
        { label: "Target", values: proj(bl("pitarg")), cls: "ref" },
        { label: blLabel, values: bl("pic4"), cls: "base" },
        { label: "Counterfactual", values: cf("pic4"), cls: "cf" },
      ],
    },
    {
      series: [
        { label: "Natural rate", values: proj(idx.map((i) => (i < t0 ? base.lurnat[i] : Y.lurnat[i - t0]))), cls: "ref" },
        { label: blLabel, values: bl("lur"), cls: "base" },
        { label: "Counterfactual", values: cf("lur"), cls: "cf" },
      ],
    },
    {
      series: [
        { label: "Potential", values: proj(idx.map(() => 0)), cls: "ref" },
        { label: blLabel, values: bl("xgap2"), cls: "base" },
        { label: "Counterfactual", values: cf("xgap2"), cls: "cf" },
      ],
    },
  ];
  charts.update({ labels, panels, markIndex });
  $("proj-note").textContent =
    `Shaded: data before the ${s.vintage} SEP. Model: ${meta.models.find((m) => m.key === s.model).label}.`;
  return { labels, panels, s };
}

// ---------- baseline editing ----------
function ensureEdits() {
  if (edits && edits.vintage === state.vintage) return;
  const n = meta.vintages.findIndex((v) => v.label === state.vintage);
  const base = {};
  for (const k of Object.keys(baselines[n])) base[k] = Float64Array.from(baselines[n][k]);
  edits = { vintage: state.vintage, base, dirty: false };
}

function levelIndex() {
  const n = meta.vintages.findIndex((v) => v.label === state.vintage);
  return Math.min(meta.dates.length - 1, meta.vintages[n].t0 + meta.T - 1);
}

function syncBrush() {
  document.querySelectorAll("#brush-bar button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.brush === brush));
}

function syncEditPanel() {
  if (!edits) return;
  const i = levelIndex();
  const b = edits.base;
  $("pistar").value = String(Number(b.pitarg[i].toFixed(3)));
  $("ustar").value = String(Number(b.lurnat[i].toFixed(3)));
  $("lrrate").value = String(Number((b.rstar[i] + b.pitarg[i]).toFixed(3)));
  $("lr-rate").textContent = `Implied real neutral rate r*: ${b.rstar[i].toFixed(2)}%`;
}

// Change a long-run level. The reference path shifts by the full amount from the SEP date on, and the
// baseline paths that must converge to it (inflation and the funds rate for pi*, the funds rate for r*,
// unemployment for u*) shift by the same amount, phased in over ~3 years so they start at today's data.
const LEVEL_REF = { pistar: "pitarg", ustar: "lurnat", rstar: "rstar" };
const LEVEL_PATHS = { pistar: ["pic4", "rff"], ustar: ["lur"], rstar: ["rff"] };
const PHASE_IN_Q = 12;

function setLevel(k, value) {
  if (!Number.isFinite(value)) return syncEditPanel();
  ensureEdits();
  const n = meta.vintages.findIndex((v) => v.label === state.vintage);
  const t0 = meta.vintages[n].t0;
  const li = levelIndex();
  if (k === "lrrate") { value -= edits.base.pitarg[li]; k = "rstar"; }   // nominal rate entered; r* is implied
  const ref = edits.base[LEVEL_REF[k]];
  const d = value - ref[li];
  for (let j = t0; j < ref.length; j++) {
    ref[j] += d;
    const w = 1 - Math.exp(-(j - t0) / PHASE_IN_Q);
    for (const v of LEVEL_PATHS[k]) edits.base[v][j] += d * w;
  }
  edits.dirty = true;
  syncEditPanel();
  renderEdit();
}

function onDragStart(k) {
  dragOrig = Float64Array.from(edits.base[EDIT_VARS[k]]);
}

function onDrag(k, i, dv) {
  const n = meta.vintages.findIndex((v) => v.label === state.vintage);
  const t0 = meta.vintages[n].t0, centre = t0 - HISTORY_Q + i;
  const sigma = Number(brush);
  const arr = edits.base[EDIT_VARS[k]];
  for (let j = t0; j < arr.length; j++) {
    const w = brush === "point" ? (j === centre ? 1 : 0) : Math.exp(-0.5 * ((j - centre) / sigma) ** 2);
    arr[j] = dragOrig[j] + dv * (w < 1e-4 ? 0 : w);
  }
  edits.dirty = true;
  renderEdit();
}

function renderEdit() {
  const s = state;
  const n = meta.vintages.findIndex((v) => v.label === s.vintage);
  const t0 = meta.vintages[n].t0, orig = baselines[n], cur = edits.base;
  const start = t0 - HISTORY_Q, end = t0 + 4 * s.years;
  const idx = [], labels = [];
  for (let i = start; i < end; i++) { idx.push(i); labels.push(quarterLabel(meta.dates[i])); }
  const markIndex = HISTORY_Q;
  const get = (b, v) => idx.map((i) => b[v][i]);
  const proj = (arr) => arr.map((v, k) => (k < markIndex ? null : v));
  const lr = idx.map((i) => cur.rstar[i] + cur.pitarg[i]);
  const mk = (v, ref) => {
    const ser = [{ label: ref.label, values: proj(ref.values), cls: "ref" }];
    if (edits.dirty) ser.push({ label: "SEP baseline", values: get(orig, v), cls: "base" });
    ser.push({ label: edits.dirty ? "Edited baseline" : "SEP baseline", values: get(cur, v), cls: "cf" });
    return { series: ser, editIdx: ser.length - 1, hlines: v === "rff" && s.elb_on ? [{ y: meta.elb, label: "ELB" }] : [] };
  };
  const panels = [
    mk("rff", { label: "Long-run rate", values: lr }),
    mk("pic4", { label: "Target", values: get(cur, "pitarg") }),
    mk("lur", { label: "Natural rate", values: get(cur, "lurnat") }),
    mk("xgap2", { label: "Potential", values: idx.map(() => 0) }),
  ];
  const status = $("status");
  status.textContent = edits.dirty
    ? "Baseline edited. Switch to Counterfactual to compute policy against it."
    : "Editing mode: drag a baseline line, or change the long-run levels on the left.";
  status.dataset.kind = "";
  $("proj-note").textContent = `Shaded: data before the ${s.vintage} SEP. Only projected quarters can be edited.`;
  charts.update({ labels, panels, markIndex, editable: true });
  lastResult = { labels, panels, s };
}

function setMode(m) {
  mode = m;
  document.querySelectorAll("input[name=mode]").forEach((r) => { r.checked = r.value === m; });
  $("policy-section").hidden = $("elb-section").hidden = m === "edit";
  $("edit-section").hidden = m !== "edit";
  $("brush-bar").hidden = m !== "edit";
  if (m === "edit") { ensureEdits(); syncEditPanel(); }
  schedule();
}

function downloadCsv() {
  if (!lastResult) return;
  const { labels, panels, s } = lastResult;
  const names = ["rff", "inflation", "unemployment", "output gap"];
  const cols = [];
  panels.forEach((p, k) => p.series.forEach((ser) => cols.push({ name: `${names[k]} ${ser.label}`, values: ser.values })));
  const lines = [
    `# Hebden & Winkler, policy counterfactuals; ${location.href}`,
    ["quarter", ...cols.map((c) => c.name)].join(","),
    ...labels.map((l, i) => [l, ...cols.map((c) => (c.values[i] == null ? "" : c.values[i].toFixed(4)))].join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `counterfactual_${s.model}_${s.vintage.replace(":", "")}_${s.policy}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function quarterLabel(x) {
  const y = Math.floor(x + 1e-9);
  return `${y}:Q${Math.round((x - y) * 4) + 1}`;
}

// ---------- boot ----------
async function main() {
  try {
    meta = await loadMeta(DATA_DIR);
    baselines = await loadBaselines(DATA_DIR, meta);
  } catch (e) {
    $("status").textContent = `Could not load data (${e.message}).`;
    return;
  }
  charts = new LinkedCharts($("charts"), [
    { title: "Federal funds rate (%)" },
    { title: "Inflation, 4-quarter PCE (%)" },
    { title: "Unemployment rate (%)" },
    { title: "Output gap (% of potential)" },
  ], { onDragStart, onDrag });
  buildControls();
  state = readHash();
  syncControls();
  setMode("cf");
  window.addEventListener("hashchange", () => {
    const s = readHash();
    if (JSON.stringify(s) !== JSON.stringify(state)) { state = s; syncControls(); schedule(); }
  });
}

main();
