import { calculateAicIncludedCreditsContext, getUsageMonthKey, type AicIncludedCreditsContext, type AicIncludedCreditsOverrides } from '../pipeline/aicIncludedCredits'
import { getAicUsageMetrics, getUsageMetrics, parseNormalizedTokenUsageRecord, parseTokenUsageHeader, type TokenUsageHeader, type TokenUsageRecord } from '../pipeline/parser'
import { getProductBudgetName, isNonCopilotCodeReviewUsage, NON_COPILOT_CODE_REVIEW_USER_LABEL, type ProductBudgetName } from '../pipeline/productClassification'
import { streamLines } from '../pipeline/streamer'

export type CostCenterSimulationResult = {
  costCenterName: string
  budgetUsd: number
  additionalSpendConsumed: number
  amountBlocked: number
  utilizationPercent: number
  exhaustionDate: string | null
  consumptionPercent: number
}

export type BudgetSimulationResult = {
  totalBill: number
  blockedUsers: number
  blockedRequests: number
  blockedIncludedCreditsAic: number
  budgetExhausted: boolean
  firstUserBlockedDate: string | null
  accountBlockedDate: string | null
  costCenterBlockedDates: Record<string, string>
  costCenterResults: CostCenterSimulationResult[]
  productBlockedDates: Partial<Record<ProductBudgetName, string>>
  adjustedDailyNetCostByDate: Array<{ date: string; amount: number }>
}

export type BudgetSimulationOptions = {
  accountBudgetUsd?: number
  userBudgetUsd?: number
  powerUserBudgetsUsd?: Record<string, number>
  costCenterBudgetsUsd?: Record<string, number>
  productBudgetsUsd?: Partial<Record<ProductBudgetName, number>>
}

type BudgetSimulationContext = Pick<AicIncludedCreditsContext, 'reportPlanScope' | 'organizationIncludedCreditsPool' | 'individualMonthlyIncludedCredits'>
type CostCenterBudgetState = {
  remainingBudget: number
  additionalSpendConsumed: number
  totalAicGrossConsumed: number
  exhaustionDate: string | null
}

type BudgetSimulationState = {
  remainingAccountBudget: number
  userBudgetCap: number
  powerUserBudgets: Map<string, number>
  costCenterBudgets: Map<string, CostCenterBudgetState>
  costCenterBlockedDates: Record<string, string>
  totalAicGrossAmount: number
  remainingProductBudgetByName: Map<ProductBudgetName, number>
  remainingOrganizationIncludedCredits: number
  totalBill: number
  blockedRequests: number
  budgetExhausted: boolean
  firstUserBlockedDate: string | null
  accountBlockedDate: string | null
  productBlockedDates: Partial<Record<ProductBudgetName, string>>
  blockedUsers: Set<string>
  adjustedDailyNetCostByDate: Map<string, number>
  remainingUserBudgetByUser: Map<string, number>
  remainingMonthlyIncludedCredits: Map<string, number>
  seenIndividualIncludedCreditKeys: Set<string>
}

function normalizeBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.POSITIVE_INFINITY
  return Math.max(value, 0)
}

function getMaxQuantityByAdditionalSpendBudget(
  aicQuantity: number,
  remainingIncludedCredits: number,
  remainingBudgetUsd: number,
  costPerAic: number,
): number {
  if (remainingBudgetUsd === Number.POSITIVE_INFINITY) {
    return aicQuantity
  }

  return Math.min(aicQuantity, remainingIncludedCredits + (remainingBudgetUsd / costPerAic))
}

function getIndividualIncludedCreditKey(record: TokenUsageRecord): string | null {
  const username = record.username.trim()
  const monthKey = getUsageMonthKey(record.date.trim())
  if (!username || !monthKey) {
    return null
  }

  return `${username}\u0000${monthKey}`
}

function getBudgetSubject(record: TokenUsageRecord): string | null {
  const username = record.username.trim()
  if (username) {
    return username
  }

  if (isNonCopilotCodeReviewUsage(record)) {
    return NON_COPILOT_CODE_REVIEW_USER_LABEL
  }

  return null
}

function createBudgetSimulationState(
  options: BudgetSimulationOptions,
  context: BudgetSimulationContext,
): BudgetSimulationState {
  const costCenterBudgets = new Map<string, CostCenterBudgetState>()
  for (const [name, amount] of Object.entries(options.costCenterBudgetsUsd ?? {})) {
    const budget = normalizeBudget(amount)
    if (budget !== Number.POSITIVE_INFINITY) {
      costCenterBudgets.set(name, {
        remainingBudget: budget,
        additionalSpendConsumed: 0,
        totalAicGrossConsumed: 0,
        exhaustionDate: null,
      })
    }
  }

  return {
    remainingAccountBudget: normalizeBudget(options.accountBudgetUsd),
    userBudgetCap: normalizeBudget(options.userBudgetUsd),
    powerUserBudgets: new Map<string, number>(Object.entries(options.powerUserBudgetsUsd ?? {})
      .map(([username, amount]) => [username, normalizeBudget(amount)])),
    costCenterBudgets,
    costCenterBlockedDates: {},
    totalAicGrossAmount: 0,
    remainingProductBudgetByName: new Map<ProductBudgetName, number>(Object.entries(options.productBudgetsUsd ?? {})
      .map(([name, amount]) => [name as ProductBudgetName, normalizeBudget(amount)])),
    remainingOrganizationIncludedCredits: context.organizationIncludedCreditsPool,
    totalBill: 0,
    blockedRequests: 0,
    budgetExhausted: false,
    firstUserBlockedDate: null,
    accountBlockedDate: null,
    productBlockedDates: {},
    blockedUsers: new Set<string>(),
    adjustedDailyNetCostByDate: new Map<string, number>(),
    remainingUserBudgetByUser: new Map<string, number>(),
    remainingMonthlyIncludedCredits: new Map<string, number>(),
    seenIndividualIncludedCreditKeys: new Set<string>(),
  }
}

function getRemainingIncludedCredits(
  record: TokenUsageRecord,
  context: BudgetSimulationContext,
  remainingOrganizationIncludedCredits: number,
  remainingMonthlyIncludedCredits: Map<string, number>,
): number {
  if (context.reportPlanScope === 'organization') {
    return remainingOrganizationIncludedCredits
  }

  const key = getIndividualIncludedCreditKey(record)
  if (!key) {
    return 0
  }

  return remainingMonthlyIncludedCredits.get(key) ?? context.individualMonthlyIncludedCredits
}

function setRemainingIncludedCredits(
  record: TokenUsageRecord,
  context: BudgetSimulationContext,
  coveredQuantity: number,
  remainingMonthlyIncludedCredits: Map<string, number>,
  currentRemainingOrganizationIncludedCredits: number,
): number {
  if (context.reportPlanScope === 'organization') {
    return Math.max(currentRemainingOrganizationIncludedCredits - coveredQuantity, 0)
  }

  const key = getIndividualIncludedCreditKey(record)
  if (!key) {
    return currentRemainingOrganizationIncludedCredits
  }

  const remaining = remainingMonthlyIncludedCredits.get(key) ?? context.individualMonthlyIncludedCredits
  remainingMonthlyIncludedCredits.set(key, Math.max(remaining - coveredQuantity, 0))
  return currentRemainingOrganizationIncludedCredits
}

function getEffectiveUserBudget(
  state: BudgetSimulationState,
  budgetSubject: string | null,
): number {
  if (!budgetSubject) return Number.POSITIVE_INFINITY

  // Power user override takes precedence
  const powerUserBudget = state.powerUserBudgets.get(budgetSubject)
  if (powerUserBudget !== undefined) {
    return state.remainingUserBudgetByUser.get(budgetSubject) ?? powerUserBudget
  }

  // Fall back to universal user budget
  if (state.userBudgetCap === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY
  return state.remainingUserBudgetByUser.get(budgetSubject) ?? state.userBudgetCap
}

function getCostCenterName(record: TokenUsageRecord): string | null {
  const name = record.cost_center_name?.trim()
  return name || null
}

function simulateBudgetRecord(
  state: BudgetSimulationState,
  record: TokenUsageRecord,
  context: BudgetSimulationContext,
): void {
    const budgetSubject = getBudgetSubject(record)
    const productBudgetName = getProductBudgetName(record)
    const costCenterName = getCostCenterName(record)
    const { requests } = getUsageMetrics(record)
    const { aicQuantity, aicGrossAmount } = getAicUsageMetrics(record)
    if (aicQuantity <= 0 || aicGrossAmount <= 0) {
      return
    }

    const costPerAic = aicGrossAmount / aicQuantity
    if (!Number.isFinite(costPerAic) || costPerAic <= 0) {
      return
    }

    // Track total gross for consumption % calculations
    state.totalAicGrossAmount += aicGrossAmount

    // Track per-CC gross consumption (even for CCs without a budget)
    if (costCenterName) {
      const ccState = state.costCenterBudgets.get(costCenterName)
      if (ccState) {
        ccState.totalAicGrossConsumed += aicGrossAmount
      }
    }

    if (context.reportPlanScope !== 'organization') {
      const individualIncludedCreditKey = getIndividualIncludedCreditKey(record)
      if (individualIncludedCreditKey) {
        state.seenIndividualIncludedCreditKeys.add(individualIncludedCreditKey)
      }
    }

    const remainingIncludedCredits = getRemainingIncludedCredits(
      record,
      context,
      state.remainingOrganizationIncludedCredits,
      state.remainingMonthlyIncludedCredits,
    )

    // --- Gate order per spec §4: account → cost center → user → product ---

    // Gate 2: Account additional-spend cap
    const maxQuantityByAccountBudget = getMaxQuantityByAdditionalSpendBudget(
      aicQuantity,
      remainingIncludedCredits,
      state.remainingAccountBudget,
      costPerAic,
    )

    // Gate 3: Cost center additional-spend cap (bypass if no CC or no CC budget)
    const ccBudgetState = costCenterName ? state.costCenterBudgets.get(costCenterName) : undefined
    const remainingCcBudget = ccBudgetState ? ccBudgetState.remainingBudget : Number.POSITIVE_INFINITY
    const maxQuantityByCcBudget = getMaxQuantityByAdditionalSpendBudget(
      aicQuantity,
      remainingIncludedCredits,
      remainingCcBudget,
      costPerAic,
    )

    // Gate 4: User total-usage cap (covers pool + additional)
    const remainingUserBudget = getEffectiveUserBudget(state, budgetSubject)
    const maxQuantityByUserBudget = remainingUserBudget === Number.POSITIVE_INFINITY
      ? aicQuantity
      : Math.min(aicQuantity, remainingUserBudget / costPerAic)

    // Product budget (app-specific extension, after spec gates)
    const remainingProductBudget = state.remainingProductBudgetByName.get(productBudgetName) ?? Number.POSITIVE_INFINITY
    const maxQuantityByProductBudget = getMaxQuantityByAdditionalSpendBudget(
      aicQuantity,
      remainingIncludedCredits,
      remainingProductBudget,
      costPerAic,
    )

    // Lowest headroom wins
    const allowedQuantity = Math.max(0, Math.min(aicQuantity, maxQuantityByAccountBudget, maxQuantityByCcBudget, maxQuantityByUserBudget, maxQuantityByProductBudget))
    const allowedRatio = allowedQuantity / aicQuantity

    // Determine which gate is the binding constraint (spec: "lowest remaining headroom wins")
    const accountBudgetLimited = maxQuantityByAccountBudget < aicQuantity
      && maxQuantityByAccountBudget <= maxQuantityByCcBudget
      && maxQuantityByAccountBudget <= maxQuantityByUserBudget
      && maxQuantityByAccountBudget <= maxQuantityByProductBudget
    const ccBudgetLimited = maxQuantityByCcBudget < aicQuantity
      && maxQuantityByCcBudget <= maxQuantityByAccountBudget
      && maxQuantityByCcBudget <= maxQuantityByUserBudget
      && maxQuantityByCcBudget <= maxQuantityByProductBudget
    const userBudgetLimited = maxQuantityByUserBudget < aicQuantity
      && maxQuantityByUserBudget <= maxQuantityByAccountBudget
      && maxQuantityByUserBudget <= maxQuantityByCcBudget
      && maxQuantityByUserBudget <= maxQuantityByProductBudget
    const productBudgetLimited = maxQuantityByProductBudget < aicQuantity
      && maxQuantityByProductBudget <= maxQuantityByAccountBudget
      && maxQuantityByProductBudget <= maxQuantityByCcBudget
      && maxQuantityByProductBudget <= maxQuantityByUserBudget

    if (allowedRatio < 1) {
      state.blockedRequests += requests * (1 - allowedRatio)
      if (budgetSubject) {
        state.blockedUsers.add(budgetSubject)
      }
      if (userBudgetLimited && state.firstUserBlockedDate === null) {
        state.firstUserBlockedDate = record.date || null
      }
    }

    if (allowedQuantity <= 0) {
      if (state.remainingAccountBudget <= 0 && remainingIncludedCredits <= 0) {
        state.budgetExhausted = true
        if (state.accountBlockedDate === null) {
          state.accountBlockedDate = record.date || null
        }
      }
      if (costCenterName && ccBudgetState && remainingCcBudget <= 0 && remainingIncludedCredits <= 0 && record.date && state.costCenterBlockedDates[costCenterName] === undefined) {
        state.costCenterBlockedDates[costCenterName] = record.date
      }
      if (remainingProductBudget <= 0 && remainingIncludedCredits <= 0 && record.date && state.productBlockedDates[productBudgetName] === undefined) {
        state.productBlockedDates[productBudgetName] = record.date
      }
      return
    }

    const allowedGrossAmount = aicGrossAmount * allowedRatio
    const coveredQuantity = Math.min(allowedQuantity, remainingIncludedCredits)
    const additionalUsageQuantity = Math.max(allowedQuantity - coveredQuantity, 0)
    const additionalSpendAmount = additionalUsageQuantity * costPerAic

    state.totalBill += additionalSpendAmount
    if (additionalSpendAmount > 0 && record.date) {
      state.adjustedDailyNetCostByDate.set(record.date, (state.adjustedDailyNetCostByDate.get(record.date) ?? 0) + additionalSpendAmount)
    }

    // Update account budget state
    if (accountBudgetLimited && allowedQuantity > remainingIncludedCredits && state.accountBlockedDate === null) {
      state.accountBlockedDate = record.date || null
      state.budgetExhausted = true
    }
    if (state.remainingAccountBudget !== Number.POSITIVE_INFINITY) {
      const nextRemainingAccountBudget = Math.max(state.remainingAccountBudget - additionalSpendAmount, 0)
      if (
        nextRemainingAccountBudget <= 0
        && additionalSpendAmount > 0
        && remainingIncludedCredits <= 0
        && state.accountBlockedDate === null
      ) {
        state.accountBlockedDate = record.date || null
        state.budgetExhausted = true
      }
      state.remainingAccountBudget = nextRemainingAccountBudget
    }

    // Update cost center budget state
    if (costCenterName && ccBudgetState) {
      ccBudgetState.additionalSpendConsumed += additionalSpendAmount
      if (ccBudgetState.remainingBudget !== Number.POSITIVE_INFINITY) {
        const nextRemainingCcBudget = Math.max(ccBudgetState.remainingBudget - additionalSpendAmount, 0)
        if (
          nextRemainingCcBudget <= 0
          && additionalSpendAmount > 0
          && remainingIncludedCredits <= 0
          && record.date
          && state.costCenterBlockedDates[costCenterName] === undefined
        ) {
          state.costCenterBlockedDates[costCenterName] = record.date
        }
        ccBudgetState.remainingBudget = nextRemainingCcBudget
      }
      if (ccBudgetLimited && allowedQuantity > remainingIncludedCredits && record.date && state.costCenterBlockedDates[costCenterName] === undefined) {
        state.costCenterBlockedDates[costCenterName] = record.date
      }
    }

    // Update product budget state
    if (productBudgetLimited && allowedQuantity > remainingIncludedCredits && record.date && state.productBlockedDates[productBudgetName] === undefined) {
      state.productBlockedDates[productBudgetName] = record.date
    }
    if (remainingProductBudget !== Number.POSITIVE_INFINITY) {
      const nextRemainingProductBudget = Math.max(remainingProductBudget - additionalSpendAmount, 0)
      if (
        nextRemainingProductBudget <= 0
        && additionalSpendAmount > 0
        && remainingIncludedCredits <= 0
        && record.date
        && state.productBlockedDates[productBudgetName] === undefined
      ) {
        state.productBlockedDates[productBudgetName] = record.date
      }
      state.remainingProductBudgetByName.set(productBudgetName, nextRemainingProductBudget)
    }

    // Update user budget state
    if (budgetSubject && remainingUserBudget !== Number.POSITIVE_INFINITY) {
      state.remainingUserBudgetByUser.set(budgetSubject, Math.max(remainingUserBudget - allowedGrossAmount, 0))
    }

    state.remainingOrganizationIncludedCredits = setRemainingIncludedCredits(
      record,
      context,
      coveredQuantity,
      state.remainingMonthlyIncludedCredits,
      state.remainingOrganizationIncludedCredits,
    )
}

function finalizeBudgetSimulation(
  state: BudgetSimulationState,
  context: BudgetSimulationContext,
): BudgetSimulationResult {
  const blockedIncludedCreditsAic = context.reportPlanScope === 'organization'
    ? state.remainingOrganizationIncludedCredits
    : Array.from(state.seenIndividualIncludedCreditKeys).reduce(
      (total, key) => total + (state.remainingMonthlyIncludedCredits.get(key) ?? context.individualMonthlyIncludedCredits),
      0,
    )

  const costCenterResults: CostCenterSimulationResult[] = Array.from(state.costCenterBudgets.entries())
    .map(([costCenterName, ccState]) => {
      const budgetUsd = ccState.additionalSpendConsumed + ccState.remainingBudget
      const additionalSpendConsumed = ccState.additionalSpendConsumed
      const amountBlocked = Math.max(0, budgetUsd - additionalSpendConsumed) <= 0
        ? 0  // budget was fully consumed
        : 0
      const utilizationPercent = budgetUsd > 0 ? Math.min(100, (additionalSpendConsumed / budgetUsd) * 100) : 0
      const consumptionPercent = state.totalAicGrossAmount > 0
        ? (ccState.totalAicGrossConsumed / state.totalAicGrossAmount) * 100
        : 0

      return {
        costCenterName,
        budgetUsd,
        additionalSpendConsumed,
        amountBlocked: Math.max(0, additionalSpendConsumed - budgetUsd + ccState.remainingBudget),
        utilizationPercent,
        exhaustionDate: state.costCenterBlockedDates[costCenterName] ?? null,
        consumptionPercent,
      }
    })
    .sort((a, b) => b.consumptionPercent - a.consumptionPercent)

  return {
    totalBill: state.totalBill,
    blockedUsers: state.blockedUsers.size,
    blockedRequests: Math.round(state.blockedRequests),
    blockedIncludedCreditsAic,
    budgetExhausted: state.budgetExhausted,
    firstUserBlockedDate: state.firstUserBlockedDate,
    accountBlockedDate: state.accountBlockedDate,
    costCenterBlockedDates: state.costCenterBlockedDates,
    costCenterResults,
    productBlockedDates: state.productBlockedDates,
    adjustedDailyNetCostByDate: Array.from(state.adjustedDailyNetCostByDate.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, amount]) => ({ date, amount })),
  }
}

export function simulateBudgetFromRecords(
  records: TokenUsageRecord[],
  options: BudgetSimulationOptions,
  context: BudgetSimulationContext,
): BudgetSimulationResult {
  const state = createBudgetSimulationState(options, context)

  for (const record of records) {
    simulateBudgetRecord(state, record, context)
  }

  return finalizeBudgetSimulation(state, context)
}

export async function runBudgetSimulation(
  file: File,
  options: BudgetSimulationOptions,
  includedCreditsOverrides: AicIncludedCreditsOverrides = {},
): Promise<BudgetSimulationResult> {
  const context = await calculateAicIncludedCreditsContext(file, includedCreditsOverrides)
  const state = createBudgetSimulationState(options, context)
  let header: TokenUsageHeader | null = null

  for await (const line of streamLines(file)) {
    const trimmed = line.trimEnd()
    if (!trimmed) continue

    if (!header) {
      header = parseTokenUsageHeader(trimmed)
      continue
    }

    const record = parseNormalizedTokenUsageRecord(trimmed, header)
    if (!record) continue

    simulateBudgetRecord(state, record, context)
  }

  return finalizeBudgetSimulation(state, context)
}
