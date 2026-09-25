import { loadMeta, loadModel, loadBaselines } from "./data.js?v=__BUILD__";
import { createSequenceRunner } from "./solver.js?v=__BUILD__";
import { LinkedCharts } from "./chart.js?v=__BUILD__";

const DATA_DIR = "data";
const HISTORY_Q = 8;   // quarters of data shown before the projection starts
const STEP_DELAY_MS = 500;   // pause between updates while animating a sequence

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
  model: "linver_mcapwp", startVintage: "2020:Q2", endVintage: "2020:Q2", policy: "rule",
  rho: 0, phi_pi: 1.5, phi_u: 1, phi_du: 0,
  lam_u: 1, lam_dr: 1,
  elb_on: true, years: 6,
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let meta, baselines, charts, state, pending = false, lastResult = null, runToken = 0;
let mode = "cf";        // "cf" (counterfactual) or "edit" (baseline editing, solver off)
let edits = null;       // { vintage, base: {rff,pic4,lur,lurnat,rstar,pitarg,hggdp}, dirty } working copy of one vintage's baseline
let dragOrig = null;
let brush = "2";        // "point" | quarters of the smoothing kernel (2 = 1 year, 6 = 3 years)
const EDIT_VARS = ["rff", "pic4", "lur", "hggdp"];   // variable behind each chart panel, in edit mode

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
  if (q.has("vintage") && !q.has("start") && !q.has("end")) s.startVintage = s.endVintage = q.get("vintage");
  if (!meta.models.some((m) => m.key === s.model)) s.model = DEFAULT.model;
  if (!meta.vintages.some((v) => v.label === s.startVintage)) s.startVintage = DEFAULT.startVintage;
  if (!meta.vintages.some((v) => v.label === s.endVintage)) s.endVintage = s.startVintage;
  if (vintageYear(s.endVintage) < vintageYear(s.startVintage)) s.endVintage = s.startVintage;
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

function vintageYear(label) {
  const v = meta.vintages.find((x) => x.label === label);
  return v ? v.year : -Infinity;
}

// Every dataset vintage from `startLabel` through `endLabel`, inclusive, in chronological order.
function vintageSequence(startLabel, endLabel) {
  const lo = vintageYear(startLabel), hi = vintageYear(endLabel);
  return meta.vintages
    .map((v, n) => ({ n, year: v.year }))
    .filter((v) => v.year >= lo - 1e-9 && v.year <= hi + 1e-9)
    .sort((a, b) => a.year - b.year)
    .map((v) => v.n);
}

// ---------- controls ----------
function buildControls() {
  const model = $("model");
  for (const m of meta.models) model.add(new Option(m.label, m.key));

  for (const id of ["vintage-start", "vintage-end"]) {
    const sel = $(id);
    const groups = {};
    for (const v of meta.vintages) {
      if (!groups[v.group]) {
        groups[v.group] = document.createElement("optgroup");
        groups[v.group].label = v.group;
      }
      groups[v.group].appendChild(new Option(v.label, v.label));
    }
    Object.values(groups).forEach((g) => sel.appendChild(g));
  }

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
  $("vintage-start").addEventListener("change", () => {
    const startVintage = $("vintage-start").value;
    const endVintage = vintageYear(state.endVintage) < vintageYear(startVintage) ? startVintage : state.endVintage;
    set({ startVintage, endVintage });
  });
  $("vintage-end").addEventListener("change", () => {
    const v = $("vintage-end").value;
    set({ endVintage: vintageYear(v) < vintageYear(state.startVintage) ? state.startVintage : v });
  });
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
  for (const k of ["pistar", "ustar", "lrrate", "gstar"]) {
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
  $("vintage-start").value = state.startVintage;
  $("vintage-end").value = state.endVintage;
  const seq = vintageSequence(state.startVintage, state.endVintage);
  $("sequence-hint").textContent = seq.length > 1
    ? `${seq.length} SEP releases: the counterfactual updates as each one arrives, animated ${STEP_DELAY_MS / 1000}s apart.`
    : "";
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
  if (patch.startVintage && patch.startVintage !== state.startVintage && edits?.dirty &&
      !confirm("Changing the policy start date discards your edits. Continue?")) {
    syncControls();
    return;
  }
  if (patch.startVintage && patch.startVintage !== state.startVintage) edits = null;
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
  const myToken = ++runToken;   // any later call to run() invalidates this one, mid-animation or not
  const status = $("status");
  document.body.classList.add("busy");
  let model;
  try {
    model = await loadModel(DATA_DIR, meta, s.model);
  } catch (e) {
    status.textContent = `Could not load model data (${e.message}).`;
    document.body.classList.remove("busy");
    return;
  }
  if (myToken !== runToken) return;   // superseded while loading

  if (mode === "edit") {
    document.body.classList.remove("busy");
    ensureEdits();
    syncEditPanel();
    renderEdit();
    return;
  }

  document.body.classList.remove("busy");   // don't dim the charts while a sequence animates
  const seq = vintageSequence(s.startVintage, s.endVintage);
  const t0First = meta.vintages[seq[0]].t0, t0Final = meta.vintages[seq.at(-1)].t0;
  const dispRange = { start: t0First - HISTORY_Q, end: Math.min(meta.dates.length, t0Final + 4 * s.years), markIndex: HISTORY_Q };
  const policy = s.policy === "rule"
    ? { type: "rule", rho: s.rho, phi_pi: s.phi_pi, phi_u: s.phi_u, phi_du: s.phi_du }
    : { type: "commitment", lam_u: s.lam_u, lam_dr: s.lam_dr };
  const runner = createSequenceRunner(model, policy, { useElb: s.elb_on, elb: meta.elb });

  let lastLcp = { converged: true, bindingQuarters: 0 }, stoppedAt = -1, usedEdit = false;
  let lastGood = null;   // snapshot after the latest update that solved, kept in case a later one has no ELB solution
  for (let i = 0; i < seq.length; i++) {
    const n = seq[i];
    const isEditedStep = !!(edits?.dirty && edits.vintage === meta.vintages[n].label);
    if (isEditedStep) usedEdit = true;
    const full = isEditedStep ? edits.base : baselines[n];

    let out;
    try {
      out = runner.step(full, meta.vintages[n].t0);
    } catch (e) {
      status.textContent = `No solution for these settings: ${e.message}`;
      status.dataset.kind = "error";
      document.body.classList.remove("busy");
      return;
    }
    if (myToken !== runToken) return;

    const bad = Object.values(out.Y).some((a) => a.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e3));
    if (bad) {
      status.textContent = s.policy === "rule"
        ? "These settings produce an explosive path. Try a stronger response to inflation."
        : "These settings produce an explosive path. Try a larger rate-change weight.";
      status.dataset.kind = "error";
      document.body.classList.remove("busy");
      return;
    }

    lastLcp = out.lcp;
    const converged = !s.elb_on || out.lcp.converged;
    if (!converged) {
      stoppedAt = i;
      // Keep showing the counterfactual through the last update that did solve; only if the very first
      // update fails is there nothing to show (baseline and reference lines only).
      lastResult = lastGood
        ? render(s, lastGood.full, lastGood.t0, lastGood.Y, dispRange, true, lastGood.isEditedStep)
        : render(s, full, meta.vintages[n].t0, out.Y, dispRange, false, isEditedStep);
      break;
    }
    lastResult = render(s, full, meta.vintages[n].t0, out.Y, dispRange, true, isEditedStep);
    lastGood = { full, t0: meta.vintages[n].t0, isEditedStep, label: meta.vintages[n].label, count: i + 1,
      Y: Object.fromEntries(Object.entries(out.Y).map(([k, a]) => [k, a.slice()])) };

    if (i < seq.length - 1) {
      status.textContent = `Updating through ${meta.vintages[seq[i + 1]].label}… (${i + 1} of ${seq.length})`;
      status.dataset.kind = "";
      await sleep(STEP_DELAY_MS);
      if (myToken !== runToken) return;
    }
  }
  document.body.classList.remove("busy");

  const bits = [];
  if (stoppedAt >= 0) {
    const failed = meta.vintages[seq[stoppedAt]].label;
    bits.push(lastGood
      ? `No solution with the ELB was found updating to ${failed}, so the sequence stops there: the counterfactual is shown ` +
        `through ${lastGood.label} (${lastGood.count} of ${seq.length} updates). Untick the ELB box to continue past it.`
      : `No solution with the ELB was found at ${failed}, so no counterfactual is shown. Untick the ELB box to see the unconstrained path.`);
  } else if (s.elb_on) {
    const q = lastLcp.bindingQuarters;
    bits.push(q ? `ELB binds in ${q} quarter${q > 1 ? "s" : ""} of the final projection.` : "ELB does not bind in the final projection.");
  }
  if (usedEdit) bits.push("Using your edited projection.");
  if (stoppedAt < 0) bits.push(seq.length > 1 ? `${seq.length} updates computed.` : "Computed.");
  status.textContent = bits.join(" ");
  status.dataset.kind = stoppedAt >= 0 ? "error" : "";
}

// GDP growth: the SEP database may or may not carry a baseline path for it (see tools/export_data.py).
const hasGrowthBase = () => meta.bvars.includes("hggdp");
// Long-run GDP growth: the terminal value of the baseline path (the database has no separate long-run series).
const terminal = (path) => path[path.length - 1];
// 2020:Q2 and Q3 GDP growth (about -30% and +30% annualized) would swamp the axis, so the growth panel
// leaves them out of its y-range; the lines are clipped at the plot edge there.
const covidQuarters = (idx) => idx.map((i) => Math.abs(meta.dates[i] - 2020.25) < 1e-9 || Math.abs(meta.dates[i] - 2020.5) < 1e-9);
const GROWTH_TITLE = "GDP growth (%, quarterly annualized)";

// full: the CURRENT step's own baseline (real or, for the one edited vintage, edited) -- used for the
// gray "SEP-consistent projection" line and the dashed reference lines, which are this vintage's own view.
// Y: the sequence runner's running, absolute-date-indexed accumulation -- the blue "Counterfactual" line,
// reflecting every update honored so far plus this vintage's own forward projection beyond its own date.
function render(s, full, t0, Y, { start, end, markIndex }, converged = true, isEditedStep = false) {
  const labels = [], idx = [];
  for (let i = start; i < end; i++) { idx.push(i); labels.push(quarterLabel(meta.dates[i])); }
  // The counterfactual always runs from the policy start (jumping off the last data point before it):
  // the quarters already rolled through show what was committed, later ones this update's projection.
  const t0First = start + markIndex;
  const cf = (v) => idx.map((i) => (i < t0First - 1 ? null : i < t0First ? full[v][i] : Y[v][i]));
  const bl = (v) => idx.map((i) => full[v][i]);
  const blLabel = isEditedStep ? "Edited projection" : "SEP-consistent projection";

  const longrun = idx.map((i) => full.rstar[i] + full.pitarg[i]);
  const panels = [
    {
      series: [
        { label: "Long-run rate", values: longrun, cls: "ref" },
        { label: blLabel, values: bl("rff"), cls: "base" },
        { label: "Counterfactual", values: cf("rff"), cls: "cf" },
      ],
      hlines: s.elb_on ? [{ y: meta.elb, label: "ELB" }] : [],
    },
    {
      series: [
        { label: "Target", values: bl("pitarg"), cls: "ref" },
        { label: blLabel, values: bl("pic4"), cls: "base" },
        { label: "Counterfactual", values: cf("pic4"), cls: "cf" },
      ],
    },
    {
      series: [
        { label: "Natural rate", values: idx.map((i) => (i < t0First ? full.lurnat[i] : Y.lurnat[i])), cls: "ref" },
        { label: blLabel, values: bl("lur"), cls: "base" },
        { label: "Counterfactual", values: cf("lur"), cls: "cf" },
      ],
    },
  ];
  if (hasGrowthBase()) {
    panels.push({
      title: GROWTH_TITLE,
      rangeSkip: covidQuarters(idx),
      series: [
        { label: "Long-run growth", values: idx.map(() => terminal(full.hggdp)), cls: "ref" },
        { label: blLabel, values: bl("hggdp"), cls: "base" },
        { label: "Counterfactual", values: cf("hggdp"), cls: "cf" },
      ],
    });
  }
  // No ELB solution: draw only the baseline and reference lines.
  if (!converged) for (const p of panels) p.series = p.series.filter((ser) => ser.cls !== "cf");
  charts.update({ labels, panels, markIndex, asofIndex: t0 - start });
  $("proj-note").textContent =
    `Dotted line: policy start (${s.startVintage}); grey: forecast as of the latest update. Model: ${meta.models.find((m) => m.key === s.model).label}.`;
  return { labels, panels, s };
}

// ---------- baseline editing ----------
// Edit mode always targets the "Policy start date" vintage; "update through" is hidden while editing.
function ensureEdits() {
  if (edits && edits.vintage === state.startVintage) return;
  const n = meta.vintages.findIndex((v) => v.label === state.startVintage);
  const base = {};
  for (const k of Object.keys(baselines[n])) base[k] = Float64Array.from(baselines[n][k]);
  edits = { vintage: state.startVintage, base, dirty: false };
}

function levelIndex() {
  const n = meta.vintages.findIndex((v) => v.label === state.startVintage);
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
  $("gstar-row").hidden = !hasGrowthBase();
  if (hasGrowthBase()) $("gstar").value = String(Number(terminal(b.hggdp).toFixed(3)));
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
  const n = meta.vintages.findIndex((v) => v.label === state.startVintage);
  const t0 = meta.vintages[n].t0;
  const li = levelIndex();
  if (k === "gstar") {   // long-run growth is the terminal value of the growth path itself; shift the path toward it
    const g = edits.base.hggdp, d = value - terminal(g);
    for (let j = t0; j < g.length; j++) g[j] += d * (1 - Math.exp(-(j - t0) / PHASE_IN_Q));
    edits.dirty = true;
    syncEditPanel();
    renderEdit();
    return;
  }
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
  const n = meta.vintages.findIndex((v) => v.label === state.startVintage);
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
  const n = meta.vintages.findIndex((v) => v.label === s.startVintage);
  const t0 = meta.vintages[n].t0, orig = baselines[n], cur = edits.base;
  const start = t0 - HISTORY_Q, end = t0 + 4 * s.years;
  const idx = [], labels = [];
  for (let i = start; i < end; i++) { idx.push(i); labels.push(quarterLabel(meta.dates[i])); }
  const markIndex = HISTORY_Q;
  const get = (b, v) => idx.map((i) => b[v][i]);
  const lr = idx.map((i) => cur.rstar[i] + cur.pitarg[i]);
  const mk = (v, ref) => {
    const ser = ref ? [{ label: ref.label, values: ref.values, cls: "ref" }] : [];
    if (edits.dirty) ser.push({ label: "SEP-consistent projection", values: get(orig, v), cls: "base" });
    ser.push({ label: edits.dirty ? "Edited projection" : "SEP-consistent projection", values: get(cur, v), cls: "cf" });
    return { series: ser, editIdx: ser.length - 1, hlines: v === "rff" && s.elb_on ? [{ y: meta.elb, label: "ELB" }] : [] };
  };
  const panels = [
    mk("rff", { label: "Long-run rate", values: lr }),
    mk("pic4", { label: "Target", values: get(cur, "pitarg") }),
    mk("lur", { label: "Natural rate", values: get(cur, "lurnat") }),
    // Without a baseline for GDP growth there is nothing to edit; the panel is hidden in this mode.
    hasGrowthBase() ? { ...mk("hggdp", { label: "Long-run growth", values: idx.map(() => terminal(cur.hggdp)) }), title: GROWTH_TITLE, rangeSkip: covidQuarters(idx) } : { series: [], hidden: true },
  ];
  const status = $("status");
  status.textContent = edits.dirty
    ? "Baseline edited. Switch to Counterfactual to compute policy against it."
    : "Editing mode: drag a projection line, or change the long-run levels on the left.";
  status.dataset.kind = "";
  $("proj-note").textContent = `Dotted line: policy start (${s.startVintage}); grey: forecast. Only forecast quarters can be edited.`;
  charts.update({ labels, panels, markIndex, editable: true });
  lastResult = { labels, panels, s };
}

function setMode(m) {
  mode = m;
  document.querySelectorAll("input[name=mode]").forEach((r) => { r.checked = r.value === m; });
  $("policy-section").hidden = $("elb-section").hidden = m === "edit";
  $("edit-section").hidden = m !== "edit";
  $("brush-bar").hidden = m !== "edit";
  $("vintage-end").closest("label").hidden = m === "edit";
  $("sequence-hint").hidden = m === "edit";
  if (m === "edit") { ensureEdits(); syncEditPanel(); }
  schedule();
}

function downloadCsv() {
  if (!lastResult) return;
  const { labels, panels, s } = lastResult;
  const names = ["rff", "inflation", "unemployment", "GDP growth"];
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
  const range = s.startVintage === s.endVintage ? s.startVintage.replace(":", "") : `${s.startVintage.replace(":", "")}-${s.endVintage.replace(":", "")}`;
  a.download = `counterfactual_${s.model}_${range}_${s.policy}.csv`;
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
    ...(meta.bvars.includes("hggdp") ? [{ title: GROWTH_TITLE }] : []),
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
