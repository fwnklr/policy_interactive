// Small SVG line-chart panels with a shared x axis and a linked crosshair.
//
// update({ labels, panels: [{ series, hlines, yUnit }], markIndex })
//   labels:    x-axis labels ("2020:Q2"), one per point
//   series:    [{ label, values (number|null per point), cls, dash }]
//   hlines:    [{ y, label }] thin horizontal reference lines (e.g. the ELB)
//   markIndex: index of the first simulated quarter (policy start; dotted vertical rule)
//   asofIndex: index where the grey "forecast" region starts (defaults to markIndex; moves right
//              as a sequence of updates rolls forward)

const NS = "http://www.w3.org/2000/svg";
const M = { top: 14, right: 14, bottom: 26, left: 40 };

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

function niceStep(span, count) {
  const raw = span / Math.max(1, count);
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

function fmt(v, digits = 2) {
  return v == null || Number.isNaN(v) ? "–" : v.toFixed(digits);
}

export class LinkedCharts {
  constructor(root, specs, handlers = {}) {
    this.root = root;
    this.handlers = handlers;
    this.drag = null;
    this.freeze = null;
    this.uid = Math.random().toString(36).slice(2, 8);
    this.panels = specs.map((spec) => {
      const wrap = document.createElement("figure");
      wrap.className = "panel";
      const head = document.createElement("figcaption");
      const h = document.createElement("h3");
      h.textContent = spec.title;
      const legend = document.createElement("div");
      legend.className = "panel-legend";
      head.append(h, legend);
      const box = document.createElement("div");
      box.className = "plot";
      const svg = el("svg", { role: "img", "aria-label": spec.title, tabindex: "0" }, box);
      const tip = document.createElement("div");
      tip.className = "tooltip";
      tip.hidden = true;
      box.appendChild(tip);
      wrap.append(head, box);
      root.appendChild(wrap);
      const panel = { spec, wrap, legend, box, svg, tip, scale: null };
      this.#bindHover(panel);
      return panel;
    });
    this.hover = null;
    new ResizeObserver(() => this.data && this.#draw()).observe(root);
  }

  update(data) {
    this.data = data;
    this.root.classList.toggle("editable", !!data.editable);
    this.#draw();
  }

  #draw() {
    const { labels, panels, markIndex } = this.data;
    const asofIndex = this.data.asofIndex ?? markIndex;   // where the grey "forecast" region begins
    const n = labels.length;
    this.panels.forEach((p, k) => {
      const d = panels[k];
      p.wrap.hidden = !!d.hidden;
      if (d.title) p.wrap.querySelector("h3").textContent = d.title;
      if (d.hidden) { p.scale = null; p.svg.replaceChildren(); return; }
      this.#legend(p, d);
      const W = p.box.clientWidth || 600;
      const H = p.box.clientHeight || 200;
      const svg = p.svg;
      svg.replaceChildren();
      const defs = el("defs", {}, svg);
      el("rect", { x: M.left, y: M.top - 2, width: W - M.left - M.right, height: H - M.top - M.bottom + 4 }, el("clipPath", { id: `clip-${k}-${this.uid}` }, defs));
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.setAttribute("width", W);
      svg.setAttribute("height", H);

      let lo = Infinity, hi = -Infinity;
      // d.rangeSkip[i] (optional): quarters left out of the axis range, e.g. extreme outliers; their
      // line segments are clipped at the plot edge instead.
      for (const s of d.series) s.values.forEach((v, i) => { if (v != null && !d.rangeSkip?.[i]) { lo = Math.min(lo, v); hi = Math.max(hi, v); } });
      for (const h of d.hlines || []) { lo = Math.min(lo, h.y); hi = Math.max(hi, h.y); }
      if (hi - lo < 1) { const c = (hi + lo) / 2; lo = c - 0.5; hi = c + 0.5; }
      const step = niceStep(hi - lo, H < 180 ? 3 : 4);
      lo = Math.floor(lo / step) * step;
      hi = Math.ceil(hi / step) * step;
      if (this.freeze?.[k]) ({ lo, hi } = this.freeze[k]);   // fixed axis while dragging

      const x = (i) => M.left + (i / (n - 1)) * (W - M.left - M.right);
      const y = (v) => M.top + (1 - (v - lo) / (hi - lo)) * (H - M.top - M.bottom);
      p.scale = { x, y, W, H, n, lo, hi };

      // grey "forecast" region (from the current update onward) + dotted rule at the policy start date
      if (asofIndex > 0 && asofIndex - 1 < n - 1) {
        const px = x(asofIndex - 1);
        el("rect", { class: "projection", x: px, y: M.top, width: W - M.right - px, height: H - M.top - M.bottom }, svg);
        const lab = el("text", { class: "proj-label", x: W - M.right - 6, y: M.top + 12, "text-anchor": "end" }, svg);
        lab.textContent = "Forecast";
      }
      if (markIndex > 0) {
        el("line", { class: "mark-rule", x1: x(markIndex - 1), x2: x(markIndex - 1), y1: M.top, y2: H - M.bottom }, svg);
      }

      // y grid + ticks
      const digits = step < 0.1 ? 2 : step < 1 ? 1 : 0;
      for (let v = lo; v <= hi + step / 2; v += step) {
        el("line", { class: "grid", x1: M.left, x2: W - M.right, y1: y(v), y2: y(v) }, svg);
        const t = el("text", { class: "tick", x: M.left - 6, y: y(v), "text-anchor": "end", "dominant-baseline": "middle" }, svg);
        t.textContent = v.toFixed(digits);
      }
      // x ticks: first quarter of each year (thinned on narrow widths)
      const years = [];
      labels.forEach((l, i) => { if (l.endsWith("Q1")) years.push(i); });
      const every = Math.ceil(years.length / Math.max(2, Math.floor((W - M.left - M.right) / 56)));
      years.forEach((i, j) => {
        if (j % every) return;
        el("line", { class: "axis", x1: x(i), x2: x(i), y1: H - M.bottom, y2: H - M.bottom + 4 }, svg);
        const t = el("text", { class: "tick", x: x(i), y: H - M.bottom + 16, "text-anchor": "middle" }, svg);
        t.textContent = labels[i].slice(0, 4);
      });
      el("line", { class: "axis", x1: M.left, x2: W - M.right, y1: H - M.bottom, y2: H - M.bottom }, svg);

      for (const h of d.hlines || []) {
        el("line", { class: "hline", x1: M.left, x2: W - M.right, y1: y(h.y), y2: y(h.y) }, svg);
        const t = el("text", { class: "hline-label", x: W - M.right - 2, y: y(h.y) - 4, "text-anchor": "end" }, svg);
        t.textContent = h.label;
      }

      // series: reference and baseline first, counterfactual on top
      for (const s of d.series) {
        let path = "", pen = false;
        s.values.forEach((v, i) => {
          if (v == null) { pen = false; return; }
          path += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
          pen = true;
        });
        el("path", { d: path, class: `series ${s.cls}`, "clip-path": `url(#clip-${k}-${this.uid})` }, svg);
      }

      p.crossLayer = el("g", { class: "cross", "clip-path": `url(#clip-${k}-${this.uid})` }, svg);
      p.hit = el("rect", { class: "hit", x: M.left, y: 0, width: W - M.left - M.right, height: H }, svg);
    });
    if (this.hover != null) this.#showHover(this.hover, this.hoverPanel);
  }

  #legend(p, d) {
    p.legend.replaceChildren();
    for (const s of d.series) {
      const item = document.createElement("span");
      item.className = "key";
      const sw = el("svg", { width: 18, height: 8, "aria-hidden": "true" });
      el("line", { x1: 1, x2: 17, y1: 4, y2: 4, class: `series ${s.cls}` }, sw);
      const txt = document.createElement("span");
      txt.textContent = s.label;
      item.append(sw, txt);
      p.legend.appendChild(item);
    }
  }

  #bindHover(p) {
    const move = (ev) => {
      if (!p.scale) return;
      const r = p.svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * p.scale.W;
      const { n, W } = p.scale;
      const i = Math.round(((px - M.left) / (W - M.left - M.right)) * (n - 1));
      this.#showHover(Math.max(0, Math.min(n - 1, i)), p);
    };
    const valueAt = (ev) => {
      const r = p.svg.getBoundingClientRect();
      const py = ((ev.clientY - r.top) / r.height) * p.scale.H;
      const { lo, hi, H } = p.scale;
      return { py, v: lo + (1 - (py - M.top) / (H - M.top - M.bottom)) * (hi - lo) };
    };
    const pointerIndex = (ev) => {
      const r = p.svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * p.scale.W;
      const { n, W } = p.scale;
      return Math.max(0, Math.min(n - 1, Math.round(((px - M.left) / (W - M.left - M.right)) * (n - 1))));
    };
    p.svg.addEventListener("pointermove", (ev) => {
      if (this.drag && this.drag.p === p) {
        const dv = valueAt(ev).v - this.drag.v0;
        this.handlers.onDrag?.(this.panels.indexOf(p), this.drag.i, dv);
        return;
      }
      move(ev);
    });
    p.svg.addEventListener("pointerdown", (ev) => {
      move(ev);
      const d = this.data;
      if (!d?.editable || !p.scale) return;
      const k = this.panels.indexOf(p);
      const i = pointerIndex(ev);
      const s = d.panels[k].series[d.panels[k].editIdx];
      const val = s?.values[i];
      if (i < d.markIndex || val == null) return;
      const { py, v } = valueAt(ev);
      if (Math.abs(py - p.scale.y(val)) > 30) return;    // must grab near the line
      this.drag = { p, i, v0: v };
      this.freeze = this.panels.map((q) => {
        if (!q.scale) return null;
        const pad = (q.scale.hi - q.scale.lo) * 0.3;
        return { lo: q.scale.lo - pad, hi: q.scale.hi + pad };
      });
      p.svg.setPointerCapture(ev.pointerId);
      this.handlers.onDragStart?.(k, i);
      this.#draw();
      this.drag.v0 = valueAt(ev).v;   // measure the grab point on the frozen (padded) scale used while dragging
    });
    const end = () => {
      if (!this.drag) return;
      this.drag = null;
      this.freeze = null;
      this.handlers.onDragEnd?.();
      this.#draw();
    };
    p.svg.addEventListener("pointerup", end);
    p.svg.addEventListener("pointercancel", end);
    p.svg.addEventListener("pointerleave", () => this.#hideHover());
    p.svg.addEventListener("blur", () => this.#hideHover());
    p.svg.addEventListener("keydown", (ev) => {
      if (!this.data) return;
      const n = this.data.labels.length;
      let i = this.hover ?? this.data.markIndex;
      if (ev.key === "ArrowRight") i = Math.min(n - 1, i + 1);
      else if (ev.key === "ArrowLeft") i = Math.max(0, i - 1);
      else if (ev.key === "Escape") return this.#hideHover();
      else return;
      ev.preventDefault();
      this.#showHover(i, p);
    });
  }

  #showHover(i, active) {
    this.hover = i;
    this.hoverPanel = active;
    const { labels, panels } = this.data;
    this.panels.forEach((p, k) => {
      if (!p.scale) return;
      const { x, y, H } = p.scale;
      p.crossLayer.replaceChildren();
      el("line", { class: "crosshair", x1: x(i), x2: x(i), y1: M.top, y2: H - M.bottom }, p.crossLayer);
      const rows = [];
      for (const s of panels[k].series) {
        const v = s.values[i];
        if (v == null) continue;
        el("circle", { class: `dot ${s.cls}`, cx: x(i), cy: y(v), r: 4 }, p.crossLayer);
        rows.push([s, v]);
      }
      if (p !== active) { p.tip.hidden = true; return; }
      p.tip.replaceChildren();
      const head = document.createElement("div");
      head.className = "tip-date";
      head.textContent = labels[i];
      p.tip.appendChild(head);
      for (const [s, v] of rows) {
        const row = document.createElement("div");
        row.className = "tip-row";
        const sw = el("svg", { width: 12, height: 8, "aria-hidden": "true" });
        el("line", { x1: 0, x2: 12, y1: 4, y2: 4, class: `series ${s.cls}` }, sw);
        const val = document.createElement("strong");
        val.textContent = fmt(v);
        const lab = document.createElement("span");
        lab.textContent = s.label;
        row.append(sw, val, lab);
        p.tip.appendChild(row);
      }
      p.tip.hidden = false;
      const tw = p.tip.offsetWidth, bw = p.box.clientWidth;
      const left = x(i) + 12 + tw > bw ? x(i) - 12 - tw : x(i) + 12;
      p.tip.style.left = `${Math.max(0, left)}px`;
    });
  }

  #hideHover() {
    this.hover = null;
    for (const p of this.panels) {
      p.crossLayer?.replaceChildren();
      p.tip.hidden = true;
    }
  }
}
