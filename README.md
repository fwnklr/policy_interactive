# policy_interactive

Interactive policy counterfactuals in sequence space, based on

Hebden, J. and F. Winkler (2026), "Computation of policy counterfactuals in sequence space",
*Journal of Economic Dynamics and Control* 182, 105228. https://doi.org/10.1016/j.jedc.2025.105228

Pick an SEP baseline and a model (FRB/US-LINVER or DGS-FHP), choose a simple interest-rate
rule or optimal commitment, set the rule coefficients or loss weights, and toggle the
effective lower bound. Counterfactuals are computed in the browser.

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
python3 tools/export_data.py      # writes web/data/
python3 tools/make_reference.py   # solves test cases with the replication Python solver
python3 -m http.server 8765       # then open http://localhost:8765/tools/test/check.html
```

The check page runs the JavaScript solver on every reference case (3 models × 4
baselines × simple rules and commitment, with and without the ELB) and reports
the largest deviation from the Python solution.

Differences from the replication code: one baseline at a time (no re-optimization
across SEP vintages), and an ELB complementarity tolerance of 1e-7 instead of 1e-3,
which makes the binding set, and therefore the solution, independent of the
random seed of the search heuristic.
