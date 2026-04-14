---
description: Statistical analysis and verification of quantitative claims
args: <task>
section: Research Workflows
topLevelCli: true
---
Run a statistical analysis for: $@

Derive a short slug from the task (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all files in this run.

## Workflow

1. **Understand** — Identify the statistical question: comparison, association, prediction, or description? Identify variables (IV, DV, covariates), sample sizes, measurement scales, and study design. If analyzing a paper's claims, extract the reported statistics verbatim.
2. **Select** — Choose appropriate test(s). Consider: parametric vs non-parametric, paired vs independent, number of groups/levels, distributional assumptions. Justify the choice and note alternatives considered.
3. **Check assumptions** — For parametric tests: normality (Shapiro-Wilk, Q-Q plots), homoscedasticity (Levene's test), independence. Report any violations and the adjusted approach (e.g., Welch's t-test, non-parametric alternative, transformation).
4. **Execute** — Write and run the analysis in Python (scipy, statsmodels, pingouin) or R. Save code to `experiments/<slug>-analysis.py`. Report for each test: test statistic, degrees of freedom, p-value, effect size (Cohen's d, η², r, odds ratio as appropriate), and confidence intervals.
5. **Interpret** — Plain-language interpretation of results. Distinguish statistical significance from practical significance. Note limitations: sample size adequacy, multiple comparisons, assumption violations. Apply corrections when running multiple tests (Bonferroni, Holm, or FDR as appropriate).
6. **Visualize** — Generate appropriate plots: box/violin plots for group comparisons, scatter with regression for associations, forest plots for multi-study data. Use `pi-charts` or save as images to `outputs/`.
7. **Report** — Save the analysis report to `outputs/<slug>-stats.md`. Include: methods, results, interpretation, code reference, limitations, and recommendations for further analysis if warranted.
