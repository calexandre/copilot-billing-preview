# Copilot Billing Preview

A tool for analyzing GitHub Copilot usage reports and simulating budget configurations under the usage-based billing model. Helps admins answer "what if we set these budget caps?" against real consumption data.

## Language

### Billing model

**AI Credit (AIC)**:
Unit of billable consumption. 1 credit = 1 US cent.
_Avoid_: token, unit

**Shared pool**:
Enterprise-scoped reservoir of credits, replenished monthly to the sum of all active license grants. Consumed unconditionally — no budget gates it.
_Avoid_: allowance, quota

**Pool charge**:
A charge classified against the shared pool. Default classification while the pool has remaining credits.

**Additional spend**:
A charge classified after the shared pool is exhausted. Subject to account and cost-center budget caps.
_Avoid_: overage (ambiguous — could mean the amount or the state)

**Included credits**:
The portion of AIC consumption covered by license grants before additional spend begins. Distinct from the shared pool in individual plans.

**Billing period**:
Calendar month. All consumption counters reset; budget configuration persists.

### Budget hierarchy

**Account budget**:
Cap on enterprise-wide additional spend for the billing period. The top-level guardrail. Set to $0 to make the pool a hard ceiling.
_Avoid_: enterprise budget (spec term — we use "account budget" as a neutral term that works for both org and individual reports)

**Cost center budget**:
Cap on additional spend within a single cost center. Not a quota — the same budget may bind or not depending on how the shared pool was consumed earlier in the period.
_Avoid_: team budget, CC quota

**User level budget**:
Universal default cap on a user's total monthly usage (pool charges + additional charges). Fair-use control, not spend control.
_Avoid_: universal default user budget (spec term — we shorten to "user level budget")

**Power User budget**:
Individual budget override for a specific user, replacing the user level budget. For known heavy consumers identified from usage data.
_Avoid_: user budget override, individual budget

**Product budget**:
Cap on additional spend for a specific product category (Copilot, Cloud Agent, Spark). App-specific — not in the authorization spec.

### Authorization gates

**Gate order**:
The spec-aligned sequence for evaluating budget caps: account budget → cost center budget → user budget. Product budgets are checked last (app-specific extension). The gate order determines the blocking reason surfaced, not the set of blocked requests.

**Pool classification**:
The implicit first step — a charge is classified as pool or additional (or split across both) based on remaining pool credits. This is not a budget gate; it's an unconditional debit.

### Entities

**Cost center**:
An organizational grouping of users. Auto-discovered from the `cost_center_name` field in the usage report CSV. Users without a cost center bypass the cost center budget gate.
_Avoid_: team, department (too specific to org structure)

## Relationships

- An **account budget** caps total **additional spend** across all users and cost centers
- A **cost center budget** caps **additional spend** within one **cost center** — it does not cap pool consumption
- A **user level budget** caps a user's **total usage** (pool + additional) — the crucial asymmetry
- A **Power User budget** replaces the **user level budget** for a specific user
- **Product budgets** operate independently, capping additional spend per product category
- The **shared pool** is consumed before any **additional spend** occurs — **pool classification** determines the split

## Example dialogue

> **Admin:** "I set cost center budgets for each team. Why did Platform hit its cap but Data didn't, even though both teams have the same budget?"
> **Domain expert:** "Because cost center budgets cap additional spend, not total consumption. If Platform users consumed less from the shared pool early in the month, they needed more additional spend to reach the same total — and hit the CC cap sooner. That's the Scenario 6.3 effect."

> **Admin:** "What's the difference between the account budget and the user level budget?"
> **Domain expert:** "Account budget caps additional spend only — it's your dollar guardrail for overage. User level budget caps total usage including pool consumption — it's your fair-use control to prevent one user from draining the pool."

## Flagged ambiguities

- **"enterprise budget" vs "account budget"** — the spec uses "enterprise budget." We use "account budget" because it works for both organization and individual report contexts. Same concept: cap on additional spend at the top level.
- **"cost center budget" is not a quota** — a cost center budget of $160 does not guarantee the team can spend $160 of additional. Whether it binds depends on how much pool credit the team's users consumed. See spec §6.3.
- **"user budget" is overloaded** — could mean the universal default or an individual override. We distinguish: "user level budget" (universal) vs "Power User budget" (per-user override).
