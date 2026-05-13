# AGENTS.md

## Test data policy

- Never add real customer data to tests, fixtures, snapshots, examples, or documentation committed to this repository.
- Always use anonymized placeholders for user-identifying and customer-identifying fields such as usernames, organization names, and cost center names.
- Prefer obviously synthetic values like `test-user`, `mona`, `octocat`, `hubot`, `example-org`, `octodemo`, and `Cost Center A` or `Octocats` so they cannot be mistaken for production data.

## Terminology

- Use **usage-based billing** terminology in code, UI copy, tests, and docs.

## Billing pipeline changes

- When changing parsing, products, SKUs, included credits, or aggregation logic, update the affected parser tests, aggregator tests, and any expectations for product or model breakdowns.
- If supported CSV values or user-visible billing behavior change, update the relevant docs in the same change.

## UI and state management

- Keep `App.tsx` focused on orchestration and layout; extract substantial view logic into dedicated view or component files.
- Prefer precomputed aggregator results over recalculating report data inside views.
- Be conservative with React state for large reports: avoid retaining duplicate derived datasets or raw data when aggregated results are sufficient.

## Performance and memory

- Assume uploaded CSV reports can be large.
- Avoid changes that significantly increase retained in-memory data, especially duplicated aggregates, large per-view caches, or UI patterns that can hold onto detached DOM trees.

## Agent skills

### Issue tracker

Issues live in GitHub Issues (uses `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary (needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (one `CONTEXT.md` + `docs/adr/` at repo root). See `docs/agents/domain.md`.
