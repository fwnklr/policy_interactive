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
  elb_on: true, elb: 0.125, years: 6,
};

const $ = (id) => document.getElementById(id);
let meta, baselines, charts, state, pending = false, lastResult = null;

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
  for (const k of ["rho", "phi_pi", "phi_u", "phi_du"]) {
    $(k).addEventListener("input", () => set({ [k]: Number($(k).value) }));
  }
  $("lam_u").max = LAM_U_STOPS.length - 1;
  $("lam_dr").max = LAM_DR_STOPS.length - 1;
  $("lam_u").addEventListener("input", () => set({ lam_u: LAM_U_STOPS[$("lam_u").value] }));
  $("lam_dr").addEventListener("input", () => set({ lam_dr: LAM_DR_STOPS[$("lam_dr").value] }));
  $("elb_on").addEventListener("change", () => set({ elb_on: $("elb_on").checked }));
  $("elb").addEventListener("input", () => set({ elb: Number($("elb").value) }));
  $("years").addEventListener("change", () => set({ years: Number($("years").value) }));
  $("reset").addEventListener("click", () => set({ ...DEFAULT }));
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
  $("elb").value = state.elb;
  $("elb").disabled = !state.elb_on;
  $("elb-out").textContent = String(Number(state.elb.toFixed(3)));
  $("years").value = state.years;
}

function set(patch) {
  state = { ...state, ...patch };
  syncControls();
  writeHash();
  schedule();
}

// ---------- compute + render ----------
function schedule() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(async () => {
    pending = false;
    await run();
  });
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
  const base = baselines[n];
  const yb = baselineWindow(base, t0, meta.T);
  const policy = s.policy === "rule"
    ? { type: "rule", rho: s.rho, phi_pi: s.phi_pi, phi_u: s.phi_u, phi_du: s.phi_du }
    : { type: "commitment", lam_u: s.lam_u, lam_dr: s.lam_dr };

  let out;
  const t = performance.now();
  try {
    out = solve(model, yb, policy, { useElb: s.elb_on, elb: s.elb });
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
    status.textContent = "These settings produce an explosive path. Try a stronger response to inflation.";
    status.dataset.kind = "error";
    return;
  }
  const bits = [];
  if (s.elb_on) {
    const q = out.lcp.bindingQuarters;
    bits.push(q ? `ELB binds in ${q} quarter${q > 1 ? "s" : ""} of the projection.` : "ELB does not bind.");
    if (!out.lcp.converged) bits.push("Warning: the ELB problem did not converge; results are approximate.");
  }
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
  const proj = (arr) => arr.map((v, k) => (k < markIndex ? null : v));

  const longrun = idx.map((i) => base.rstar[i] + base.pitarg[i]);
  const panels = [
    {
      series: [
        { label: "Long-run rate", values: proj(longrun), cls: "ref" },
        { label: "SEP baseline", values: bl("rff"), cls: "base" },
        { label: "Counterfactual", values: cf("rff"), cls: "cf" },
      ],
      hlines: s.elb_on ? [{ y: s.elb, label: "ELB" }] : [],
    },
    {
      series: [
        { label: "Target", values: proj(bl("pitarg")), cls: "ref" },
        { label: "SEP baseline", values: bl("pic4"), cls: "base" },
        { label: "Counterfactual", values: cf("pic4"), cls: "cf" },
      ],
    },
    {
      series: [
        { label: "Natural rate", values: proj(idx.map((i) => (i < t0 ? base.lurnat[i] : Y.lurnat[i - t0]))), cls: "ref" },
        { label: "SEP baseline", values: bl("lur"), cls: "base" },
        { label: "Counterfactual", values: cf("lur"), cls: "cf" },
      ],
    },
  ];
  charts.update({ labels, panels, markIndex });
  $("proj-note").textContent =
    `Shaded: data before the ${s.vintage} SEP. Model: ${meta.models.find((m) => m.key === s.model).label}.`;
  renderTable(labels, panels);
  return { labels, panels, s };
}

function renderTable(labels, panels) {
  const names = ["Fed funds rate", "Inflation", "Unemployment rate"];
  const cols = [];
  panels.forEach((p, k) => p.series.forEach((ser) => cols.push({ name: `${names[k]}: ${ser.label}`, values: ser.values })));
  const table = $("data-table");
  table.replaceChildren();
  const thead = table.createTHead().insertRow();
  for (const h of ["Quarter", ...cols.map((c) => c.name)]) {
    const th = document.createElement("th");
    th.textContent = h;
    thead.appendChild(th);
  }
  const tb = table.createTBody();
  labels.forEach((l, i) => {
    const r = tb.insertRow();
    r.insertCell().textContent = l;
    for (const c of cols) r.insertCell().textContent = c.values[i] == null ? "" : c.values[i].toFixed(2);
  });
}

function downloadCsv() {
  if (!lastResult) return;
  const { labels, panels, s } = lastResult;
  const names = ["rff", "inflation", "unemployment"];
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
  ]);
  buildControls();
  state = readHash();
  syncControls();
  schedule();
  window.addEventListener("hashchange", () => {
    const s = readHash();
    if (JSON.stringify(s) !== JSON.stringify(state)) { state = s; syncControls(); schedule(); }
  });
}

main();
