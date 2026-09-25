# policy_interactive

Interactive policy counterfactuals in sequence space, based on

Hebden, J. and F. Winkler (2026), "Computation of policy counterfactuals in sequence space",
*Journal of Economic Dynamics and Control* 182, 105228. https://doi.org/10.1016/j.jedc.2025.105228

Pick a policy start date and a model, choose a simple interest-rate rule or optimal control,
set the rule coefficients or loss weights, and toggle the effective lower bound. Move "update
projection through" forward to see the counterfactual sequentially updated as each subsequent
SEP-consistent projection arrives — honoring whatever was already committed, exactly as the
paper's recursive revision scheme prescribes (Section 5) — animated one step at a time.
Counterfactuals are computed in the browser.

**Live:** https://fwnklr.github.io/policy_interactive/

## Layout

- `web/` — static site: page, JavaScript solver (`js/solver.js`, `js/lcp.js`), charts, exported data.
  Deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main`.
- `tools/export_data.py` — exports model IRF matrices (FRB/US-LINVER, DGS-FHP, Smets–Wouters) and the SEP
  baselines (`data/sep_data.mat`) from the replication package (`../replication`) into `web/data/`.
  GDP growth (`hggdp`) responses are exported for all models; a GDP growth baseline is exported as soon as
  `sep_data.mat` contains it for every vintage.

## Rebuilding the data and testing the solver

Requires the replication package next to this folder (`../replication`) and
`numpy`/`scipy`.

```bash
python3 tools/export_data.py               # writes web/data/
python3 tools/make_reference.py            # single-vintage test cases (replication Python solver)
python3 tools/make_reference_sequence.py   # multi-vintage (sequential-updating) test cases
python3 tools/serve.py 8765                      # dev server without caching; then open:
#   http://localhost:8765/tools/test/check.html            (single vintage, web/js/solver.js `solve`)
#   http://localhost:8765/tools/test/check_sequence.html   (multi-vintage, `createSequenceRunner`)
```

`check.html` runs the JavaScript solver on every single-baseline reference case (3 models × 4
baselines × simple rules and commitment, with and without the ELB) and reports the largest
deviation from the Python solution. `check_sequence.html` does the same for chronological
sequences of several SEP-consistent projections, checking `createSequenceRunner`'s recursive
updating (used whenever "update projection through" is later than "policy start date") against
`irfoc.modelsolver.ModelSolver.solve()` called with the full baseline stack — the paper's own
recursive revision scheme, unabridged.

Differences from the replication code: an ELB complementarity tolerance of 1e-7 instead of 1e-3,
which makes the binding set, and therefore the solution, independent of the random seed of the
search heuristic.
