# Copilot AI Credits — Budget Authorization Spec

**Status:** Draft · **Effective:** 2026-06-01 · **Owner:** PDX

This spec defines the algorithm GitHub Copilot uses to authorize, charge, or block an AI-credit-consuming request under the usage-based billing model. It is intended as the reference for budget configuration, finance/ops tooling, and any internal wrappers we build around the Copilot billing surface.

**Out of scope:** per-model token estimation, Actions-minute accounting for code review, license provisioning, and the auto-mode routing algorithm.

---

## 1. Terminology

| Term | Meaning |
|---|---|
| **AI credit** | Unit of billable consumption. 1 credit = 1 US cent. All counters in this spec are in dollars for readability. |
| **License grant** | Per-user monthly dollar allowance granted by a Copilot license. Business = $19, Enterprise = $39 (base). June–Aug 2026 promo: $30 / $70. |
| **Shared pool** | Enterprise-scoped reservoir of credits. Refilled at the start of each billing period to the sum of all active license grants. |
| **Pool charge** | A request charged against the shared pool. Default classification until the pool is empty. |
| **Additional spend** | A request charged after the pool is exhausted. Subject to enterprise and cost-center overage caps. |
| **Billing period** | Calendar month. All consumption counters reset to zero at the start. Configuration (budgets) persists. |
| **Exempt request** | Request whose cost is zero by definition: code completions and next-edit suggestions. Bypasses all gates. |

---

## 2. Data model

### Entities

**Enterprise**
- `pool: dollars` — replenished monthly to `sum(licenseGrant(u) for u in activeUsers)`
- `enterpriseBudget: dollars` — cap on enterprise-wide additional spend. Default 0.
- `universalDefaultUserBudget: dollars` — fallback per-user cap when no individual override is set.
- `costCenters: [CostCenter]`
- `users: [User]`

**CostCenter**
- `costCenterBudget: dollars` — cap on additional spend within this cost center.
- `ignoreEnterpriseBudget: bool` — if true, members are not gated by the enterprise budget. Configured at the enterprise level. Advanced; use sparingly.
- `members: [User]`

**User**
- `licenseTier: enum { Business, Enterprise }` — determines monthly license grant contributed to the pool.
- `costCenter: CostCenter | null`
- `userBudget: dollars | null` — individual override; falls back to `universalDefaultUserBudget` when null.

### Counters (per billing period)

| Counter | Scope | Resets monthly |
|---|---|---|
| `poolRemaining` | Enterprise | ✓ |
| `enterpriseAdditionalSpend` | Enterprise | ✓ |
| `costCenterAdditionalSpend[cc]` | Per cost center | ✓ |
| `userTotalUsage[u]` | Per user | ✓ |

### Invariants

At any point during a billing period:

1. `0 ≤ poolRemaining ≤ enterprise.pool`
2. `enterpriseAdditionalSpend ≤ enterpriseBudget` — except for requests authorized via a cost center with `ignoreEnterpriseBudget = true`
3. `costCenterAdditionalSpend[cc] ≤ cc.costCenterBudget`
4. `userTotalUsage[u] ≤ effectiveUserBudget(u)` for all u
5. `userTotalUsage[u] = (pool charges by u) + (additional charges by u)` — both classifications count

The crucial asymmetry: **user budgets cap total usage. Enterprise and cost-center budgets cap only additional spend.**

---

## 3. Cost estimation

For a request `r` to model `m` consuming `tIn` input tokens, `tOut` output tokens, and `tCache` cache tokens:

```
cost(r) = ( priceIn(m) · tIn
          + priceOut(m) · tOut
          + priceCache(m) · tCache ) · creditMultiplier(m)
```

- `cost(r)` is in dollars (1 cent = 1 credit).
- Exempt request types short-circuit: `cost(r) = 0`.
- The `creditMultiplier(m)` captures per-model pricing tiers. Auto mode affects which `m` is selected; it does not alter this formula.

---

## 4. Authorization algorithm

```pseudo
function authorize(user, request):
    cost = estimateCost(request)
    if cost == 0:
        return APPROVED                        # exempt — no charge

    cc = user.costCenter

    # Classify based on current pool state.
    classification = (poolRemaining > 0) ? POOL : ADDITIONAL

    # If the request straddles the boundary, split it.
    if classification == POOL and cost > poolRemaining:
        poolPortion       = poolRemaining
        additionalPortion = cost - poolRemaining
    else if classification == POOL:
        poolPortion       = cost
        additionalPortion = 0
    else:                                       # ADDITIONAL
        poolPortion       = 0
        additionalPortion = cost

    # ---- Gate 2: enterprise additional-spend cap ----
    if additionalPortion > 0:
        enterpriseGated = not (cc and cc.ignoreEnterpriseBudget)
        if enterpriseGated and
           enterpriseAdditionalSpend + additionalPortion > enterpriseBudget:
            return BLOCKED("enterprise budget exceeded")

    # ---- Gate 3: cost-center additional-spend cap ----
    if additionalPortion > 0 and cc:
        if costCenterAdditionalSpend[cc] + additionalPortion > cc.costCenterBudget:
            return BLOCKED("cost center budget exceeded")

    # ---- Gate 4: user total-usage cap (always checked) ----
    budget = user.userBudget ?? enterprise.universalDefaultUserBudget
    if userTotalUsage[user] + cost > budget:
        return BLOCKED("user budget exceeded")

    # All gates passed — commit atomically.
    commit(user, poolPortion, additionalPortion)
    return APPROVED


function commit(user, poolPortion, additionalPortion):
    if poolPortion > 0:
        poolRemaining -= poolPortion

    if additionalPortion > 0:
        enterpriseAdditionalSpend += additionalPortion
        if user.costCenter:
            costCenterAdditionalSpend[user.costCenter] += additionalPortion

    userTotalUsage[user] += (poolPortion + additionalPortion)
```

### Notes on the algorithm

- **Gate 1 (pool) is implicit.** Pool consumption isn't gated by a budget — it's an unconditional debit until the pool is empty. The classification step *is* the gate.
- **Atomicity.** Gates are evaluated against the full charge before any counter is mutated. A request that fails any gate is rejected with zero side effects. Partial commits are not permitted, even on split charges.
- **Order matters for the error message, not the outcome.** "Lowest remaining headroom wins" — the first gate to fail determines the block reason surfaced to the user. The set of blocked requests is the same regardless of evaluation order.
- **`ignoreEnterpriseBudget` is an advanced option.** When set, a cost center's members continue to spend after the enterprise budget is hit. This weakens the top-level guardrail and should be used only when a specific team has been granted an independent overage allowance.

---

## 5. Reset semantics

At the start of each billing period:

1. `enterprise.pool ← sum(licenseGrant(u, currentPeriod) for u in activeUsers)`
2. `poolRemaining ← enterprise.pool`
3. `enterpriseAdditionalSpend ← 0`
4. `costCenterAdditionalSpend[cc] ← 0` for all cc
5. `userTotalUsage[u] ← 0` for all u

Budget configuration (`enterpriseBudget`, `costCenterBudget`, `userBudget`, `universalDefaultUserBudget`, `ignoreEnterpriseBudget`) is not reset.

---

## 6. Worked examples

Common setup for all three examples:

- 10 Business users → `pool = $190`
- `enterpriseBudget = $310`
- `universalDefaultUserBudget = $50`
- No per-user overrides

### 6.1 Equal usage, no cost center

Every user consumes exactly $50. Pool drained evenly ($19 per user). Additional spend drained evenly ($31 per user). All three constraints — pool, enterprise budget, user budget — bind simultaneously. Coordinated stop.

### 6.2 Cost center, equal pool consumption

Add `CostCenter A` with 5 members and `costCenterBudget = $160`. State after the pool drains evenly: `userTotalUsage[u] = $19` for all u.

Maximum additional spend Cost Center A can incur before user budgets block its members individually:
```
5 × ($50 − $19) = $155
```

`$155 < $160`, so the cost center budget never binds. Gate 4 (user budget) is the active constraint for cost center members.

### 6.3 Cost center, uneven pool consumption

Same setup as 6.2, but the pool drains unevenly: 5 non-CC users at $25 each ($125), 5 CC users at $13 each ($65), total $190.

Maximum additional spend Cost Center A can incur before user budgets block its members individually:
```
5 × ($50 − $13) = $185
```

`$185 > $160`, so the cost center budget binds first. Cost center members are blocked at $160 of collective additional spend, even though none has reached their $50 user cap.

**Implication.** A cost-center budget is not equivalent to a quota. The same configured budget may be active or inactive depending on how the shared pool was consumed earlier in the period. Pool consumption order matters for the *who-gets-blocked-when* outcome.

---

## 7. Configuration recommendations

Set in this order:

1. **`enterpriseBudget`** — the tolerable monthly overage in dollars. Set to 0 to make the pool a hard ceiling. This is the top-level guardrail; everything else operates within it (unless `ignoreEnterpriseBudget` is used).

2. **`costCenterBudget`** (per cost center) — configure only when a team needs a *different* overage cap than the enterprise default. Treat these as guardrails, not as quotas. See §6.3 for why.

3. **`universalDefaultUserBudget`** — a fair-use cap that prevents any one user from draining the pool before others get access. Sizing heuristics:
   - Cover the P90 observed monthly draw with headroom: `userBudget ≈ 1.3 × P90`
   - Or `(pool + enterpriseBudget) / activeUsers × safetyFactor`, with safetyFactor in `[1.0, 1.5]`
   - Never set it equal to the license grant (`$19` / `$39`). That defeats the pooling benefit.

4. **`userBudget` overrides** for known power users, identified from the prior-month usage export. Mind the 10,000-budget cap on the enterprise (§8).

### Anti-patterns

- Treating `costCenterBudget` as a per-team quota. It isn't one — see §6.3.
- Setting `universalDefaultUserBudget` at or below the per-user license grant. Eliminates the upside of pooling.
- Setting `enterpriseBudget` above what finance has approved, then relying on cost-center budgets to bring the total back down. Cost-center budgets cap individual cost centers, not the enterprise total.

---

## 8. Constraints and known limitations

- **10,000-budget cap per enterprise.** Counts the enterprise budget, each cost-center budget, and each individual `userBudget` override. Plan accordingly for large orgs; the API supports bulk operations.
- **No partial commits.** A request that would push any gate past its cap is fully blocked, including on split charges (§4). The user-visible failure mode is binary.
- **Code review consumes Actions minutes separately.** Outside the scope of this spec. Budget for Actions minutes via the existing Actions billing surface.
- **Exempt requests (completions, NES) do not contribute to any counter.** They cannot exhaust the pool or any budget.
- **Chargeback should not rely on cost-center counters.** Use the monthly usage CSV export, which provides per-user, per-model attribution suitable for chargeback regardless of how the pool was consumed.

---

## 9. Open questions

These are not specified in the source material (vendor webinar, May 2026) and should be confirmed before relying on a particular behavior:

1. **Cost center with `ignoreEnterpriseBudget = true` after enterprise budget is hit:** are non-CC users blocked while CC members continue to spend? (Presumed yes, based on the gate ordering.)
2. **Block-reason precedence when multiple gates would fail:** is the surfaced reason the *first* gate evaluated, or the gate with the *lowest* remaining headroom? Affects user-visible error messages and operational dashboards.
3. **Multi-cost-center membership:** if a user can belong to more than one cost center, which `costCenterBudget` and `costCenterAdditionalSpend` counter applies? (Presumed not supported, but unconfirmed.)
4. **Auto-mode model selection vs. budget headroom:** does the auto-mode router consider remaining budget headroom when selecting a model, or only task complexity and provider load?
5. **Mid-period budget changes:** if `universalDefaultUserBudget` is raised mid-period, does it apply retroactively (users already blocked are unblocked) or only to subsequent requests?
6. **Refund / clawback semantics:** if a request fails mid-stream after partial token consumption, are counters debited for the partial work, the full estimated cost, or zero?

---

*Sources: Internal GitHub Copilot usage-based billing webinar (2026-05-06). Spec drafted from transcript; no normative GitHub documentation has been cross-referenced. Confirm open questions in §9 with the GitHub account team before relying on inferred behaviors.*
