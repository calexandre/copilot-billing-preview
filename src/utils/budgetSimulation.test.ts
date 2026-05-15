import { describe, expect, it } from 'vitest'
import { PRODUCT_BUDGET_COPILOT, PRODUCT_BUDGET_COPILOT_CLOUD_AGENT, PRODUCT_BUDGET_SPARK } from '../pipeline/productClassification'
import type { TokenUsageRecord } from '../pipeline/parser'
import { runBudgetSimulation, simulateBudgetFromRecords } from './budgetSimulation'

const HEADER = [
  'date',
  'username',
  'product',
  'sku',
  'model',
  'quantity',
  'unit_type',
  'applied_cost_per_quantity',
  'gross_amount',
  'discount_amount',
  'net_amount',
  'exceeds_quota',
  'total_monthly_quota',
  'organization',
  'cost_center_name',
  'aic_quantity',
  'aic_gross_amount',
].join(',')

function createCsv(rows: string[][]): File {
  const body = [HEADER, ...rows.map((row) => row.join(','))].join('\n')
  return new File([body], 'usage.csv', { type: 'text/csv' })
}

function createRecord(overrides: Partial<TokenUsageRecord>): TokenUsageRecord {
  const quantity = overrides.quantity ?? 0

  return {
    date: '2026-06-01',
    username: 'test-user',
    product: 'copilot',
    sku: 'copilot_premium_request',
    model: 'gpt-5',
    quantity,
    unit_type: 'requests',
    applied_cost_per_quantity: 0.04,
    gross_amount: 0,
    discount_amount: 0,
    net_amount: 0,
    exceeds_quota: false,
    total_monthly_quota: 1000,
    organization: 'example-org',
    cost_center_name: 'Cost Center A',
    aic_quantity: quantity,
    aic_gross_amount: 0,
    aic_net_amount: 0,
    has_aic_quantity: true,
    has_aic_gross_amount: true,
    ...overrides,
  }
}

const pooledContext = {
  reportPlanScope: 'organization' as const,
  organizationIncludedCreditsPool: 0,
  individualMonthlyIncludedCredits: 0,
}

describe('simulateBudgetFromRecords', () => {
  it('keeps the full bill when the budget covers all additional spend', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ quantity: 20, aic_net_amount: 5, aic_gross_amount: 5 }),
      createRecord({ username: 'octocat', quantity: 10, aic_net_amount: 3, aic_gross_amount: 3 }),
    ], { accountBudgetUsd: 10 }, pooledContext)

    expect(result).toEqual({
      totalBill: 8,
      blockedUsers: 0,
      blockedRequests: 0,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: false,
      firstUserBlockedDate: null,
      firstUserBlockedUsername: null,
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [{ date: '2026-06-01', amount: 8 }],
    })
  })

  it('blocks later usage once the account additional spend budget is exhausted', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ quantity: 40, aic_net_amount: 4, aic_gross_amount: 4 }),
      createRecord({ username: 'octocat', quantity: 30, aic_net_amount: 4, aic_gross_amount: 4 }),
      createRecord({ username: 'hubot', quantity: 20, aic_net_amount: 2, aic_gross_amount: 2 }),
    ], { accountBudgetUsd: 5 }, pooledContext)

    expect(result).toEqual({
      totalBill: 5,
      blockedUsers: 2,
      blockedRequests: 43,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: true,
      firstUserBlockedDate: null,
      firstUserBlockedUsername: null,
      accountBlockedDate: '2026-06-01',
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [{ date: '2026-06-01', amount: 5 }],
    })
  })

  it('ignores usage already fully covered by included AICs', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ quantity: 50, aic_net_amount: 0, aic_gross_amount: 5 }),
      createRecord({ username: 'octocat', quantity: 25, aic_net_amount: 2.5, aic_gross_amount: 2.5 }),
    ], { accountBudgetUsd: 1 }, {
      ...pooledContext,
      organizationIncludedCreditsPool: 50,
    })

    expect(result).toEqual({
      totalBill: 1,
      blockedUsers: 1,
      blockedRequests: 15,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: true,
      firstUserBlockedDate: null,
      firstUserBlockedUsername: null,
      accountBlockedDate: '2026-06-01',
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [{ date: '2026-06-01', amount: 1 }],
    })
  })

  it('blocks only the user that hits the user-level budget first and leaves pooled AICs for others', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ username: 'mona', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
      createRecord({ username: 'mona', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
      createRecord({ username: 'octocat', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
    ], { userBudgetUsd: 5 }, {
      ...pooledContext,
      organizationIncludedCreditsPool: 100,
    })

    expect(result).toEqual({
      totalBill: 0,
      blockedUsers: 1,
      blockedRequests: 50,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: false,
      firstUserBlockedDate: '2026-06-01',
      firstUserBlockedUsername: 'mona',
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [],
    })
  })

  it('reports blocked included credits when budgets strand included AICs in the pool', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ username: 'mona', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
    ], { userBudgetUsd: 2.5 }, {
      ...pooledContext,
      organizationIncludedCreditsPool: 50,
    })

    expect(result).toEqual({
      totalBill: 0,
      blockedUsers: 1,
      blockedRequests: 25,
      blockedIncludedCreditsAic: 25,
      budgetExhausted: false,
      firstUserBlockedDate: '2026-06-01',
      firstUserBlockedUsername: 'mona',
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [],
    })
  })

  it('uses the non-copilot code review label for empty-username user budgets', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ username: '', model: 'code review', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
      createRecord({ username: '', model: 'code review', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
    ], { userBudgetUsd: 5 }, {
      ...pooledContext,
      organizationIncludedCreditsPool: 100,
    })

    expect(result).toEqual({
      totalBill: 0,
      blockedUsers: 1,
      blockedRequests: 50,
      blockedIncludedCreditsAic: 50,
      budgetExhausted: false,
      firstUserBlockedDate: '2026-06-01',
      firstUserBlockedUsername: 'Non-Copilot Users',
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [],
    })
  })

  it('handles individual-scope monthly included credits and per-user budgets independently', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ date: '2026-06-01', username: 'mona', quantity: 40, aic_quantity: 40, aic_gross_amount: 4 }),
      createRecord({ date: '2026-06-02', username: 'mona', quantity: 40, aic_quantity: 40, aic_gross_amount: 4 }),
      createRecord({ date: '2026-06-08', username: 'mona', quantity: 40, aic_quantity: 40, aic_gross_amount: 4 }),
      createRecord({ date: '2026-06-08', username: 'octocat', quantity: 20, aic_quantity: 20, aic_gross_amount: 2 }),
    ], { userBudgetUsd: 5 }, {
      reportPlanScope: 'individual',
      organizationIncludedCreditsPool: 0,
      individualMonthlyIncludedCredits: 50,
    })

    expect(result).toEqual({
      totalBill: 0,
      blockedUsers: 1,
      blockedRequests: 70,
      blockedIncludedCreditsAic: 30,
      budgetExhausted: false,
      firstUserBlockedDate: '2026-06-02',
      firstUserBlockedUsername: 'mona',
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [],
    })
  })

  it('does not count included credits that later get consumed by other usage', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ username: 'mona', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
      createRecord({ username: 'octocat', quantity: 25, aic_quantity: 25, aic_gross_amount: 2.5 }),
    ], { userBudgetUsd: 2.5 }, {
      ...pooledContext,
      organizationIncludedCreditsPool: 50,
    })

    expect(result).toEqual({
      totalBill: 0,
      blockedUsers: 1,
      blockedRequests: 25,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: false,
      firstUserBlockedDate: '2026-06-01',
      firstUserBlockedUsername: 'mona',
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [],
    })
  })

  it('does not mark the account budget as blocking while included credits still cover remaining usage', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ username: 'mona', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
      createRecord({ username: 'octocat', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
    ], { accountBudgetUsd: 0, userBudgetUsd: 2.5 }, {
      ...pooledContext,
      organizationIncludedCreditsPool: 100,
    })

    expect(result).toEqual({
      totalBill: 0,
      blockedUsers: 2,
      blockedRequests: 50,
      blockedIncludedCreditsAic: 50,
      budgetExhausted: false,
      firstUserBlockedDate: '2026-06-01',
      firstUserBlockedUsername: 'mona',
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [],
    })
  })

  it('allows account budgets to spend the included pool before blocking additional spend', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ date: '2026-06-01', username: 'mona', quantity: 1050, aic_quantity: 1050, aic_gross_amount: 1050 }),
      createRecord({ date: '2026-06-02', username: 'mona', quantity: 10, aic_quantity: 10, aic_gross_amount: 10 }),
    ], { accountBudgetUsd: 50 }, {
      ...pooledContext,
      organizationIncludedCreditsPool: 1000,
    })

    expect(result).toEqual({
      totalBill: 50,
      blockedUsers: 1,
      blockedRequests: 10,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: true,
      firstUserBlockedDate: null,
      firstUserBlockedUsername: null,
      accountBlockedDate: '2026-06-02',
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [{ date: '2026-06-01', amount: 50 }],
    })
  })

  it('records the account exhaustion date even when the budget ends exactly on a row boundary', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ date: '2026-06-02', username: 'mona', quantity: 20, aic_quantity: 20, aic_gross_amount: 2 }),
      createRecord({ date: '2026-06-03', username: 'octocat', quantity: 10, aic_quantity: 10, aic_gross_amount: 1 }),
    ], { accountBudgetUsd: 2 }, pooledContext)

    expect(result).toEqual({
      totalBill: 2,
      blockedUsers: 1,
      blockedRequests: 10,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: true,
      firstUserBlockedDate: null,
      firstUserBlockedUsername: null,
      accountBlockedDate: '2026-06-02',
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [{ date: '2026-06-02', amount: 2 }],
    })
  })

  it('allows product budgets to spend the included pool before blocking product additional spend', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ date: '2026-06-01', username: 'mona', quantity: 1050, aic_quantity: 1050, aic_gross_amount: 1050 }),
      createRecord({ date: '2026-06-02', username: 'mona', quantity: 10, aic_quantity: 10, aic_gross_amount: 10 }),
    ], {
      productBudgetsUsd: {
        [PRODUCT_BUDGET_COPILOT]: 50,
      },
    }, {
      ...pooledContext,
      organizationIncludedCreditsPool: 1000,
    })

    expect(result).toEqual({
      totalBill: 50,
      blockedUsers: 1,
      blockedRequests: 10,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: false,
      firstUserBlockedDate: null,
      firstUserBlockedUsername: null,
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {
        [PRODUCT_BUDGET_COPILOT]: '2026-06-02',
      },
      adjustedDailyNetCostByDate: [{ date: '2026-06-01', amount: 50 }],
    })
  })

  it('applies product budgets only to additional spend for the matching product bucket', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ date: '2026-06-01', model: 'coding agent', quantity: 30, aic_quantity: 30, aic_gross_amount: 3 }),
      createRecord({ date: '2026-06-01', product: 'spark', sku: 'spark_premium_request', quantity: 30, aic_quantity: 30, aic_gross_amount: 3 }),
      createRecord({ date: '2026-06-02', quantity: 20, aic_quantity: 20, aic_gross_amount: 2 }),
    ], {
      productBudgetsUsd: {
        [PRODUCT_BUDGET_COPILOT_CLOUD_AGENT]: 1,
        [PRODUCT_BUDGET_SPARK]: 3,
      },
    }, pooledContext)

    expect(result).toEqual({
      totalBill: 6,
      blockedUsers: 1,
      blockedRequests: 20,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: false,
      firstUserBlockedDate: null,
      firstUserBlockedUsername: null,
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {
        [PRODUCT_BUDGET_COPILOT_CLOUD_AGENT]: '2026-06-01',
        [PRODUCT_BUDGET_SPARK]: '2026-06-01',
      },
      adjustedDailyNetCostByDate: [
        { date: '2026-06-01', amount: 4 },
        { date: '2026-06-02', amount: 2 },
      ],
    })
  })

  it('blocks cost center members when cost center additional spend budget is exhausted', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ date: '2026-06-01', username: 'mona', cost_center_name: 'Platform', quantity: 100, aic_quantity: 100, aic_gross_amount: 10 }),
      createRecord({ date: '2026-06-02', username: 'octocat', cost_center_name: 'Platform', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
      createRecord({ date: '2026-06-03', username: 'hubot', cost_center_name: 'Data', quantity: 50, aic_quantity: 50, aic_gross_amount: 5 }),
    ], { costCenterBudgetsUsd: { Platform: 10, Data: 10 } }, pooledContext)

    expect(result.costCenterBlockedDates).toEqual({ Platform: '2026-06-01' })
    expect(result.blockedUsers).toBe(1)
    expect(result.totalBill).toBe(15)
    expect(result.costCenterResults).toHaveLength(2)
    const platformResult = result.costCenterResults.find(cc => cc.costCenterName === 'Platform')!
    expect(platformResult.exhaustionDate).toBe('2026-06-01')
    expect(platformResult.budgetUsd).toBe(10)
    const dataResult = result.costCenterResults.find(cc => cc.costCenterName === 'Data')!
    expect(dataResult.exhaustionDate).toBeNull()
  })

  it('users without a cost center bypass the cost center gate', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ date: '2026-06-01', username: 'mona', cost_center_name: null, quantity: 100, aic_quantity: 100, aic_gross_amount: 10 }),
      createRecord({ date: '2026-06-02', username: 'octocat', cost_center_name: 'Platform', quantity: 100, aic_quantity: 100, aic_gross_amount: 10 }),
    ], { costCenterBudgetsUsd: { Platform: 5 } }, pooledContext)

    expect(result.totalBill).toBe(15)
    expect(result.blockedUsers).toBe(1)
    expect(result.costCenterBlockedDates).toEqual({ Platform: '2026-06-02' })
  })

  it('applies power user budget overrides instead of the universal user budget', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ username: 'mona', quantity: 100, aic_quantity: 100, aic_gross_amount: 10 }),
      createRecord({ username: 'octocat', quantity: 100, aic_quantity: 100, aic_gross_amount: 10 }),
    ], { userBudgetUsd: 5, powerUserBudgetsUsd: { mona: 15 } }, pooledContext)

    expect(result.totalBill).toBe(15)
    expect(result.blockedUsers).toBe(1)
  })

  it('power user budgets cap total usage like universal budget', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ username: 'mona', quantity: 200, aic_quantity: 200, aic_gross_amount: 20 }),
    ], { powerUserBudgetsUsd: { mona: 8 } }, {
      ...pooledContext,
      organizationIncludedCreditsPool: 100,
    })

    expect(result.blockedUsers).toBe(1)
    expect(result.blockedRequests).toBe(120)
  })

  it('cost center results include consumption percentage', () => {
    const result = simulateBudgetFromRecords([
      createRecord({ date: '2026-06-01', username: 'mona', cost_center_name: 'Platform', quantity: 75, aic_quantity: 75, aic_gross_amount: 7.5 }),
      createRecord({ date: '2026-06-01', username: 'octocat', cost_center_name: 'Data', quantity: 25, aic_quantity: 25, aic_gross_amount: 2.5 }),
    ], { costCenterBudgetsUsd: { Platform: 100, Data: 100 } }, pooledContext)

    const platformResult = result.costCenterResults.find(cc => cc.costCenterName === 'Platform')!
    expect(platformResult.consumptionPercent).toBeCloseTo(75, 0)
    const dataResult = result.costCenterResults.find(cc => cc.costCenterName === 'Data')!
    expect(dataResult.consumptionPercent).toBeCloseTo(25, 0)
  })
})

describe('runBudgetSimulation', () => {
  it('normalizes known-window CSV rows before simulating budgets', async () => {
    const file = createCsv([
      ['2026-04-25', 'mona', 'copilot', 'copilot_premium_request', 'GPT-5', '10', 'requests', '0.04', '0.40', '0', '0.40', 'False', '0', '', '', '100', '1.00'],
    ])

    await expect(runBudgetSimulation(file, { accountBudgetUsd: 10 })).resolves.toEqual({
      totalBill: 0.5,
      blockedUsers: 0,
      blockedRequests: 0,
      blockedIncludedCreditsAic: 0,
      budgetExhausted: false,
      firstUserBlockedDate: null,
      firstUserBlockedUsername: null,
      accountBlockedDate: null,
      costCenterBlockedDates: {},
      costCenterResults: [],
      productBlockedDates: {},
      adjustedDailyNetCostByDate: [{ date: '2026-04-25', amount: 0.5 }],
    })
  })
})
