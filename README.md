# policy_interactive

Interactive policy counterfactuals in sequence space, based on

Hebden, J. and F. Winkler (2026), "Computation of policy counterfactuals in sequence space",
*Journal of Economic Dynamics and Control* 182, 105228. https://doi.org/10.1016/j.jedc.2025.105228

Pick an SEP baseline and a model (FRB/US-LINVER or DGS-FHP), choose a simple interest-rate
rule or optimal commitment, set the rule coefficients or loss weights, and toggle the
effective lower bound. Counterfactuals are computed in the browser.

## Layout

- `web/` — static site (served by GitHub Pages): page, JavaScript solver, exported data.
- `tools/export_data.py` — exports model IRF matrices and SEP baselines from the
  replication package (`../replication`) into `web/data/`.
