# Align budget simulation gate order with the authorization spec

The budget simulation engine evaluates gates in the order defined by the Copilot AI Credits Budget Authorization Spec (§4): **account budget → cost center budget → user budget → product budget**. Product budgets are an app-specific extension evaluated last.

The previous implementation checked user budget first, then account budget, then product budget. We reordered to match the spec so that (a) the blocking reason attribution is consistent with what the real Copilot billing system would report, and (b) anyone reading the code alongside the spec sees the same sequence.

**Key constraints:**

- **Account and cost center budgets cap additional spend only.** They use the `getMaxQuantityByAdditionalSpendBudget` pattern that accounts for remaining included credits before debiting the budget.
- **User budgets (universal + Power User overrides) cap total usage** — pool charges plus additional charges. This is the "crucial asymmetry" from the spec.
- **`ignoreEnterpriseBudget` is deliberately omitted.** It's an advanced option that weakens the top-level guardrail. Can be added later if a customer needs it; omitting it keeps the simulation predictable and the UI simple.
- **Product budgets are not in the spec.** They're an app feature for simulating per-product caps. Evaluated after the spec-aligned gates to avoid interfering with spec-correct blocking attribution.
