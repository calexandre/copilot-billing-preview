import { useMemo, useState } from 'react'
import { DualAxisLineChart } from '../components'
import { BillingTotalsCards } from '../components/ui'
import { PRODUCT_BUDGET_COPILOT, PRODUCT_BUDGET_COPILOT_CLOUD_AGENT, PRODUCT_BUDGET_SPARK } from '../pipeline/productClassification'
import type { BudgetSimulationResult, CostCenterSimulationResult } from '../utils/budgetSimulation'
import type { DailyUsageData } from '../pipeline/aggregators/dailyUsageAggregator'
import type { CostCenterUsage } from '../pipeline/aggregators/costCenterAggregator'
import type { UserUsage } from '../pipeline/aggregators/userUsageAggregator'
import { formatAic, formatUsd } from '../utils/format'
import type { IndividualPlanUpgradeRecommendation } from '../utils/individualPlanUpgrade'

export type BudgetField = 'user' | 'account' | 'productCloudAgent' | 'productSpark' | 'productCopilot'

export type BudgetValues = Record<BudgetField, string>

type CostManagementViewProps = {
  budgetValues: BudgetValues
  costCenterBudgets: Record<string, string>
  powerUserBudgets: Record<string, string>
  costCenters: CostCenterUsage[]
  users: UserUsage[]
  isIndividualReport: boolean
  currentPruBill: number
  currentPruGrossAmount: number
  currentPruDiscountAmount: number
  currentPruQuantity: number
  currentAicBill: number
  currentAicGrossAmount: number
  currentAicDiscountAmount: number
  currentAicQuantity: number
  licenseAmount?: number
  licenseSeatCounts?: {
    business: number
    enterprise: number
  }
  upgradeRecommendation?: IndividualPlanUpgradeRecommendation | null
  dailyUsageData: DailyUsageData[]
  budgetSimulation: BudgetSimulationResult | null
  budgetSimulationError: string | null
  isApplyingBudgetSimulation: boolean
  onBudgetValueChange: (field: BudgetField, value: string) => void
  onCostCenterBudgetChange: (costCenterName: string, value: string) => void
  onPowerUserBudgetChange: (username: string, value: string) => void
  onAddPowerUser: (username: string) => void
  onRemovePowerUser: (username: string) => void
  onApplyBudgetSimulation: () => void
}

const ACCOUNT_BUDGET_FIELDS: Array<{ field: BudgetField; label: string; description: string }> = [
  {
    field: 'account',
    label: 'Account level budget',
    description: 'Controls additional spend only for the current billing period.\nDoes not impact included credits.',
  },
]

const INDIVIDUAL_BUDGET_FIELDS: Array<{ field: BudgetField; label: string; description: string }> = [
  {
    field: 'account',
    label: 'Additional usage budget',
    description: 'Controls additional usage spend only for the current billing period.\nDoes not impact included credits.',
  },
]

const PRODUCT_BUDGET_FIELDS: Array<{ field: BudgetField; label: string; description: string }> = [
  {
    field: 'productCloudAgent',
    label: PRODUCT_BUDGET_COPILOT_CLOUD_AGENT,
    description: 'Applies only to AI Credits additional spend for Copilot Cloud Agent usage.',
  },
  {
    field: 'productSpark',
    label: PRODUCT_BUDGET_SPARK,
    description: 'Applies only to AI Credits additional spend for Spark usage.',
  },
  {
    field: 'productCopilot',
    label: PRODUCT_BUDGET_COPILOT,
    description: 'Applies only to AI Credits additional spend for Copilot usage.',
  },
]

function sanitizeUsdInput(value: string): string {
  const normalized = value.replace(/[^0-9.]/g, '')
  const [wholePart = '', ...rest] = normalized.split('.')
  const decimalPart = rest.join('').slice(0, 2)

  if (normalized.startsWith('.')) {
    return decimalPart ? `0.${decimalPart}` : '0.'
  }

  if (rest.length === 0) {
    return wholePart
  }

  return `${wholePart}.${decimalPart}`
}

function sanitizeWholeNumberInput(value: string): string {
  return value.replace(/[^0-9]/g, '')
}

function formatSimulationDate(value: string | null): string {
  if (!value) {
    return 'Not reached in this simulation.'
  }

  const dateOnly = value.includes('T') ? value.split('T')[0] : value.split(' ')[0]
  const parsed = new Date(`${dateOnly}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

const PRODUCT_SIMULATION_DETAILS = [
  { label: PRODUCT_BUDGET_COPILOT_CLOUD_AGENT, key: PRODUCT_BUDGET_COPILOT_CLOUD_AGENT },
  { label: PRODUCT_BUDGET_SPARK, key: PRODUCT_BUDGET_SPARK },
  { label: PRODUCT_BUDGET_COPILOT, key: PRODUCT_BUDGET_COPILOT },
] as const

export function CostManagementView({
  budgetValues,
  costCenterBudgets,
  powerUserBudgets,
  costCenters,
  users,
  isIndividualReport,
  currentPruBill,
  currentPruGrossAmount,
  currentPruDiscountAmount,
  currentPruQuantity,
  currentAicBill,
  currentAicGrossAmount,
  currentAicDiscountAmount,
  currentAicQuantity,
  licenseAmount,
  licenseSeatCounts,
  upgradeRecommendation = null,
  dailyUsageData,
  budgetSimulation,
  budgetSimulationError,
  isApplyingBudgetSimulation,
  onBudgetValueChange,
  onCostCenterBudgetChange,
  onPowerUserBudgetChange,
  onAddPowerUser,
  onRemovePowerUser,
  onApplyBudgetSimulation,
}: CostManagementViewProps) {
  const [powerUserInput, setPowerUserInput] = useState('')
  const [powerUserAutoFillCount, setPowerUserAutoFillCount] = useState('')
  const [powerUserAutoFillBudget, setPowerUserAutoFillBudget] = useState('')
  const [costCenterAutoFillCap, setCostCenterAutoFillCap] = useState('')
  const visibleAccountBudgetFields = isIndividualReport ? INDIVIDUAL_BUDGET_FIELDS : ACCOUNT_BUDGET_FIELDS
  const hasCostCenterBudgetValue = Object.values(costCenterBudgets).some((v) => v.trim() !== '')
  const hasPowerUserBudgetValue = Object.values(powerUserBudgets).some((v) => v.trim() !== '')
  const hasVisibleBudgetValue = visibleAccountBudgetFields.some(({ field }) => budgetValues[field].trim() !== '')
    || (!isIndividualReport && PRODUCT_BUDGET_FIELDS.some(({ field }) => budgetValues[field].trim() !== ''))
    || hasCostCenterBudgetValue
    || hasPowerUserBudgetValue

  const usersNotInCostCenter = useMemo(() => {
    const ccNames = new Set(costCenters.map((cc) => cc.costCenterName))
    return users.filter((u) => u.costCenters.length === 0 || u.costCenters.every((cc) => !ccNames.has(cc)))
  }, [costCenters, users])

  const sortedCostCenters = useMemo(
    () => [...costCenters].sort((a, b) => b.totals.aicNetAmount - a.totals.aicNetAmount),
    [costCenters],
  )

  const powerUserSuggestions = useMemo(() => {
    const already = new Set(Object.keys(powerUserBudgets))
    const query = powerUserInput.trim().toLowerCase()
    if (!query) return []
    return users
      .filter((u) => !already.has(u.username) && u.username.toLowerCase().includes(query))
      .slice(0, 10)
      .map((u) => u.username)
  }, [powerUserInput, powerUserBudgets, users])

  const powerUserAutoFillCountParsed = powerUserAutoFillCount.trim() !== '' ? parseInt(powerUserAutoFillCount, 10) : undefined
  const powerUserAutoFillBudgetParsed = powerUserAutoFillBudget.trim() !== '' ? Number(powerUserAutoFillBudget) : undefined
  const isPowerUserAutoFillEnabled = powerUserAutoFillCountParsed !== undefined
    && Number.isFinite(powerUserAutoFillCountParsed) && powerUserAutoFillCountParsed > 0
    && powerUserAutoFillBudgetParsed !== undefined
    && Number.isFinite(powerUserAutoFillBudgetParsed) && powerUserAutoFillBudgetParsed > 0

  const handleAutoFillPowerUserBudgets = () => {
    if (!isPowerUserAutoFillEnabled) return

    const count = powerUserAutoFillCountParsed!
    const budget = sanitizeUsdInput(String(powerUserAutoFillBudgetParsed!))

    // Remove existing power users
    for (const username of Object.keys(powerUserBudgets)) {
      onRemovePowerUser(username)
    }

    // Select top N users by AIC consumption
    const topUsers = [...users]
      .sort((a, b) => b.totals.aicQuantity - a.totals.aicQuantity)
      .slice(0, count)

    // Assign the budget to each
    for (const user of topUsers) {
      onPowerUserBudgetChange(user.username, budget)
    }
  }

  const accountBudgetParsed = budgetValues.account.trim() !== '' ? Number(budgetValues.account) : undefined
  const accountBudgetValue = accountBudgetParsed !== undefined && Number.isFinite(accountBudgetParsed)
    ? accountBudgetParsed
    : undefined
  const costCenterAutoFillCapParsed = costCenterAutoFillCap.trim() !== '' ? Number(costCenterAutoFillCap) : undefined
  const costCenterMaxAllocation = accountBudgetValue === undefined
    ? undefined
    : Math.min(
      accountBudgetValue,
      costCenterAutoFillCapParsed !== undefined && Number.isFinite(costCenterAutoFillCapParsed)
        ? Math.max(0, costCenterAutoFillCapParsed)
        : accountBudgetValue,
    )
  const isCostCenterAutoFillEnabled = costCenterMaxAllocation !== undefined
  const costCenterBudgetSum = Object.values(costCenterBudgets).reduce((sum, v) => {
    const n = Number(v)
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)

  const userBudgetParsed = budgetValues.user.trim() !== '' ? Number(budgetValues.user) : undefined
  const licenseGrantPerUser = licenseAmount && licenseSeatCounts
    ? licenseAmount / Math.max(licenseSeatCounts.business + licenseSeatCounts.enterprise, 1)
    : undefined

  const cumulativeSimulationSeries = useMemo(() => {
    if (!budgetSimulation) {
      return null
    }

    const currentByDate = new Map(dailyUsageData.map((day) => [day.date, day.aicNetAmount]))
    const adjustedByDate = new Map(budgetSimulation.adjustedDailyNetCostByDate.map((day) => [day.date, day.amount]))
    const labels = Array.from(new Set([...currentByDate.keys(), ...adjustedByDate.keys()])).sort()

    let currentRunningTotal = 0
    let adjustedRunningTotal = 0

    return {
      labels,
      current: labels.map((date) => {
        currentRunningTotal += currentByDate.get(date) ?? 0
        return currentRunningTotal
      }),
      adjusted: labels.map((date) => {
        adjustedRunningTotal += adjustedByDate.get(date) ?? 0
        return adjustedRunningTotal
      }),
    }
  }, [budgetSimulation, dailyUsageData])

  const handleAutoFillCostCenterBudgets = () => {
    if (costCenterMaxAllocation === undefined) {
      return
    }

    const totalConsumption = sortedCostCenters.reduce((sum, cc) => sum + Math.max(cc.totals.aicNetAmount, 0), 0)
    if (totalConsumption <= 0) {
      sortedCostCenters.forEach((cc) => onCostCenterBudgetChange(cc.costCenterName, '0'))
      return
    }

    const totalBudgetUnits = Math.floor(costCenterMaxAllocation)
    const weightedAllocations = sortedCostCenters.map((cc) => {
      const weight = Math.max(cc.totals.aicNetAmount, 0)
      const rawUnits = (weight / totalConsumption) * totalBudgetUnits
      const floorUnits = Math.floor(rawUnits)
      return {
        costCenterName: cc.costCenterName,
        floorUnits,
        fractional: rawUnits - floorUnits,
        weight,
      }
    })

    let assignedUnits = weightedAllocations.reduce((sum, item) => sum + item.floorUnits, 0)
    if (assignedUnits < totalBudgetUnits) {
      weightedAllocations
        .sort((a, b) => {
          if (b.fractional !== a.fractional) return b.fractional - a.fractional
          if (b.weight !== a.weight) return b.weight - a.weight
          return a.costCenterName.localeCompare(b.costCenterName)
        })
        .slice(0, totalBudgetUnits - assignedUnits)
        .forEach((item) => {
          item.floorUnits += 1
        })
      assignedUnits = totalBudgetUnits
    }

    if (assignedUnits > totalBudgetUnits) {
      return
    }

    weightedAllocations.forEach((item) => {
      onCostCenterBudgetChange(item.costCenterName, String(item.floorUnits))
    })
  }

  return (
    <section className="flex flex-col gap-6" aria-label="Cost management">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-lg text-fg-default">Cost management</h2>
        <p className="m-0 text-[13px] text-fg-muted">Manage editable USD budgets and see the effect they would have on current uploaded report totals.</p>
      </div>

      <BillingTotalsCards
        pruNetAmount={currentPruBill}
        pruGrossAmount={currentPruGrossAmount}
        pruDiscountAmount={currentPruDiscountAmount}
        pruQuantity={currentPruQuantity}
        aicNetAmount={currentAicBill}
        aicGrossAmount={currentAicGrossAmount}
        aicDiscountAmount={currentAicDiscountAmount}
        aicQuantity={currentAicQuantity}
        licenseAmount={licenseAmount}
        licenseSeatCounts={licenseSeatCounts}
        showNegotiatedDiscountDisclaimer={!isIndividualReport}
        showPromotionalDataDisclaimer={isIndividualReport}
        upgradeRecommendation={upgradeRecommendation}
      />

      <div className={`grid grid-cols-1 ${isIndividualReport ? '' : 'xl:grid-cols-2'} gap-4`}>
        {visibleAccountBudgetFields.map(({ field, label, description }) => (
          <label key={field} className="bg-bg-default border border-border-default rounded-md px-5 py-5 flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold text-fg-default">{label}</span>
              <span className="text-[13px] text-fg-muted leading-normal whitespace-pre-line">{description}</span>
            </div>

            <div className="flex items-center rounded-md border border-border-default bg-bg-default focus-within:border-fg-accent focus-within:shadow-[0_0_0_3px_rgba(9,105,218,0.3)]">
              <span className="pl-3 text-sm font-medium text-fg-muted" aria-hidden>
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                className="w-full border-0 bg-transparent px-2 py-2.5 text-sm text-fg-default outline-none"
                value={budgetValues[field]}
                onChange={(event) => onBudgetValueChange(field, sanitizeUsdInput(event.target.value))}
                placeholder="0.00"
                aria-label={label}
              />
            </div>
          </label>
        ))}
      </div>

      {!isIndividualReport && costCenters.length > 0 && (
        <div className="bg-bg-default border border-border-default rounded-md px-5 py-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <strong className="text-sm font-semibold text-fg-default">Cost center budgets</strong>
            <p className="m-0 text-[13px] text-fg-muted">
              Controls additional spend per cost center. Members of a cost center are blocked once its budget is exhausted.
              {usersNotInCostCenter.length > 0 && (
                <> <span className="text-fg-attention">{usersNotInCostCenter.length} user{usersNotInCostCenter.length > 1 ? 's are' : ' is'} not assigned to any cost center and will bypass this gate.</span></>
              )}
            </p>
            <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_auto] gap-3 items-end">
              <label className="flex flex-col gap-1">
                <span className="text-[13px] font-medium text-fg-default">Max budget to allocate</span>
                <div className="flex items-center rounded-md border border-border-default bg-bg-default focus-within:border-fg-accent focus-within:shadow-[0_0_0_3px_rgba(9,105,218,0.3)]">
                  <span className="pl-3 text-sm font-medium text-fg-muted" aria-hidden>
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="numeric"
                    className="w-full border-0 bg-transparent px-2 py-2.5 text-sm text-fg-default outline-none"
                    value={costCenterAutoFillCap}
                    onChange={(event) => setCostCenterAutoFillCap(sanitizeWholeNumberInput(event.target.value))}
                    placeholder="Uses account budget if empty"
                    aria-label="Maximum budget allocated to cost centers"
                  />
                </div>
              </label>
              <button
                type="button"
                className="px-3 py-2 text-[13px] font-medium border border-border-default rounded-md bg-bg-default text-fg-default cursor-pointer hover:bg-bg-muted disabled:opacity-50 disabled:cursor-default"
                onClick={handleAutoFillCostCenterBudgets}
                disabled={!isCostCenterAutoFillEnabled}
              >
                Auto-fill cost center budgets
              </button>
            </div>
            {accountBudgetValue === undefined && (
              <p className="m-0 text-[13px] text-fg-muted">
                Enter an account level budget to enable auto-fill.
              </p>
            )}
            {accountBudgetValue !== undefined && costCenterAutoFillCapParsed !== undefined && Number.isFinite(costCenterAutoFillCapParsed) && costCenterAutoFillCapParsed > accountBudgetValue && (
              <p className="m-0 text-[13px] text-fg-attention">
                Auto-fill cap is limited to the account budget ({formatUsd(accountBudgetValue)}).
              </p>
            )}
            {hasCostCenterBudgetValue && accountBudgetParsed !== undefined && costCenterBudgetSum > accountBudgetParsed && (
              <p className="m-0 text-[13px] text-fg-attention">
                ⚠️ The sum of cost center budgets ({formatUsd(costCenterBudgetSum)}) exceeds the account budget ({formatUsd(accountBudgetParsed)}).
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {sortedCostCenters.map((cc) => (
              <label key={cc.costCenterName} className="border border-border-default rounded-md px-5 py-5 flex flex-col gap-3 bg-bg-muted/30">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold text-fg-default">{cc.costCenterName}</span>
                  <span className="text-[13px] text-fg-muted leading-normal">{cc.userCount} user{cc.userCount !== 1 ? 's' : ''} · {formatUsd(cc.totals.aicNetAmount)} AIC net spend · {currentAicBill > 0 ? Math.round((cc.totals.aicNetAmount / currentAicBill) * 100) : 0}%</span>
                </div>

                <div className="flex items-center rounded-md border border-border-default bg-bg-default focus-within:border-fg-accent focus-within:shadow-[0_0_0_3px_rgba(9,105,218,0.3)]">
                  <span className="pl-3 text-sm font-medium text-fg-muted" aria-hidden>
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="numeric"
                    className="w-full border-0 bg-transparent px-2 py-2.5 text-sm text-fg-default outline-none"
                    value={costCenterBudgets[cc.costCenterName] ?? ''}
                    onChange={(event) => onCostCenterBudgetChange(cc.costCenterName, sanitizeWholeNumberInput(event.target.value))}
                    placeholder="0"
                    aria-label={`${cc.costCenterName} budget`}
                  />
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {!isIndividualReport && (
        <div className="bg-bg-default border border-border-default rounded-md px-5 py-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <strong className="text-sm font-semibold text-fg-default">User level budgets</strong>
            <p className="m-0 text-[13px] text-fg-muted">
              Applies to pooled AI Credits and additional spend. Controls how many AI Credits a user can spend in total.
            </p>
            {userBudgetParsed !== undefined && licenseGrantPerUser !== undefined && userBudgetParsed <= licenseGrantPerUser && (
              <p className="m-0 text-[13px] text-fg-attention">
                ⚠️ The user level budget ({formatUsd(userBudgetParsed)}) is at or below the per-user license grant ({formatUsd(licenseGrantPerUser)}). Users may be blocked before using any additional spend.
              </p>
            )}
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <label className="border border-border-default rounded-md px-5 py-5 flex flex-col gap-3 bg-bg-muted/30">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-semibold text-fg-default">User level budget</span>
                <span className="text-[13px] text-fg-muted leading-normal">Universal budget applied to every user.</span>
              </div>

              <div className="flex items-center rounded-md border border-border-default bg-bg-default focus-within:border-fg-accent focus-within:shadow-[0_0_0_3px_rgba(9,105,218,0.3)]">
                <span className="pl-3 text-sm font-medium text-fg-muted" aria-hidden>
                  $
                </span>
                <input
                  type="text"
                  inputMode="decimal"
                  className="w-full border-0 bg-transparent px-2 py-2.5 text-sm text-fg-default outline-none"
                  value={budgetValues.user}
                  onChange={(event) => onBudgetValueChange('user', sanitizeUsdInput(event.target.value))}
                  placeholder="0.00"
                  aria-label="User level budget"
                />
              </div>
            </label>

            <div className="border border-border-default rounded-md px-5 py-5 flex flex-col gap-3 bg-bg-muted/30">
              <div className="flex flex-col gap-1">
                <span className="text-sm font-semibold text-fg-default">Power user budgets</span>
                <span className="text-[13px] text-fg-muted leading-normal">Override the universal user level budget for specific users.</span>
              </div>

              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr_auto] gap-3 items-end">
                  <label className="flex flex-col gap-1">
                    <span className="text-[13px] font-medium text-fg-default">Number of power users</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      className="w-full rounded-md border border-border-default bg-bg-default px-3 py-2.5 text-sm text-fg-default outline-none focus:border-fg-accent focus:shadow-[0_0_0_3px_rgba(9,105,218,0.3)]"
                      value={powerUserAutoFillCount}
                      onChange={(e) => setPowerUserAutoFillCount(sanitizeWholeNumberInput(e.target.value))}
                      placeholder="e.g. 50"
                      aria-label="Number of power users to auto-fill"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-[13px] font-medium text-fg-default">Budget per power user</span>
                    <div className="flex items-center rounded-md border border-border-default bg-bg-default focus-within:border-fg-accent focus-within:shadow-[0_0_0_3px_rgba(9,105,218,0.3)]">
                      <span className="pl-3 text-sm font-medium text-fg-muted" aria-hidden>$</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="w-full border-0 bg-transparent px-2 py-2.5 text-sm text-fg-default outline-none"
                        value={powerUserAutoFillBudget}
                        onChange={(e) => setPowerUserAutoFillBudget(sanitizeUsdInput(e.target.value))}
                        placeholder="0.00"
                        aria-label="Power user budget amount"
                      />
                    </div>
                  </label>
                  <button
                    type="button"
                    className="px-3 py-2 text-[13px] font-medium border border-border-default rounded-md bg-bg-default text-fg-default cursor-pointer hover:bg-bg-muted disabled:opacity-50 disabled:cursor-default"
                    onClick={handleAutoFillPowerUserBudgets}
                    disabled={!isPowerUserAutoFillEnabled}
                  >
                    Auto-fill power user budgets
                  </button>
                </div>
                <p className="m-0 text-[13px] text-fg-muted">
                  Selects the top users by AIC consumption and assigns them the specified budget. Replaces any existing power user entries.
                </p>

                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      className="w-full rounded-md border border-border-default bg-bg-default px-3 py-2 text-sm text-fg-default outline-none focus:border-fg-accent focus:shadow-[0_0_0_3px_rgba(9,105,218,0.3)]"
                      value={powerUserInput}
                      onChange={(e) => setPowerUserInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && powerUserInput.trim()) {
                          onAddPowerUser(powerUserInput.trim())
                          setPowerUserInput('')
                        }
                      }}
                      placeholder="Search for a user to add…"
                      aria-label="Add power user"
                    />
                    {powerUserSuggestions.length > 0 && (
                      <ul className="absolute z-10 mt-1 w-full bg-bg-default border border-border-default rounded-md shadow-lg max-h-48 overflow-y-auto">
                        {powerUserSuggestions.map((username) => (
                          <li key={username}>
                            <button
                              type="button"
                              className="w-full text-left px-3 py-2 text-sm text-fg-default hover:bg-bg-muted cursor-pointer border-0 bg-transparent"
                              onClick={() => {
                                onAddPowerUser(username)
                                setPowerUserInput('')
                              }}
                            >
                              {username}
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <button
                    type="button"
                    className="px-3 py-2 text-[13px] font-medium border border-border-default rounded-md bg-bg-default text-fg-default cursor-pointer hover:bg-bg-muted disabled:opacity-50 disabled:cursor-default"
                    onClick={() => {
                      if (powerUserInput.trim()) {
                        onAddPowerUser(powerUserInput.trim())
                        setPowerUserInput('')
                      }
                    }}
                    disabled={!powerUserInput.trim()}
                  >
                    Add
                  </button>
                </div>

                {Object.keys(powerUserBudgets).length > 0 && (
                  <div className="flex flex-col gap-3">
                    {Object.entries(powerUserBudgets).map(([username, value]) => (
                      <div key={username} className="border border-border-default rounded-md px-4 py-3 flex flex-col gap-2 bg-bg-default">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-semibold text-fg-default">{username}</span>
                          <button
                            type="button"
                            className="text-xs text-fg-muted hover:text-fg-danger cursor-pointer border-0 bg-transparent"
                            onClick={() => onRemovePowerUser(username)}
                            aria-label={`Remove ${username}`}
                          >
                            ✕
                          </button>
                        </div>

                        <div className="flex items-center rounded-md border border-border-default bg-bg-default focus-within:border-fg-accent focus-within:shadow-[0_0_0_3px_rgba(9,105,218,0.3)]">
                          <span className="pl-3 text-sm font-medium text-fg-muted" aria-hidden>
                            $
                          </span>
                          <input
                            type="text"
                            inputMode="decimal"
                            className="w-full border-0 bg-transparent px-2 py-2.5 text-sm text-fg-default outline-none"
                            value={value}
                            onChange={(event) => onPowerUserBudgetChange(username, sanitizeUsdInput(event.target.value))}
                            placeholder="0.00"
                            aria-label={`${username} budget`}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {!isIndividualReport && (
        <div className="bg-bg-default border border-border-default rounded-md px-5 py-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <strong className="text-sm font-semibold text-fg-default">Product-level budgets</strong>
            <p className="m-0 text-[13px] text-fg-muted">
              These budgets apply only to <strong className="text-fg-default">AIC additional spend</strong>. Included credits can still be used before additional spend blocking starts.
            </p>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            {PRODUCT_BUDGET_FIELDS.map(({ field, label, description }) => (
              <label key={field} className="border border-border-default rounded-md px-5 py-5 flex flex-col gap-3 bg-bg-muted/30">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-semibold text-fg-default">{label}</span>
                  <span className="text-[13px] text-fg-muted leading-normal">{description}</span>
                </div>

                <div className="flex items-center rounded-md border border-border-default bg-bg-default focus-within:border-fg-accent focus-within:shadow-[0_0_0_3px_rgba(9,105,218,0.3)]">
                  <span className="pl-3 text-sm font-medium text-fg-muted" aria-hidden>
                    $
                  </span>
                  <input
                    type="text"
                    inputMode="decimal"
                    className="w-full border-0 bg-transparent px-2 py-2.5 text-sm text-fg-default outline-none"
                    value={budgetValues[field]}
                    onChange={(event) => onBudgetValueChange(field, sanitizeUsdInput(event.target.value))}
                    placeholder="0.00"
                    aria-label={label}
                  />
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="m-0 text-[13px] text-fg-muted">
            {isIndividualReport
              ? <>The simulation applies the <strong className="text-fg-default">additional usage budget</strong> against total paid AIC additional spend after included credits are used.</>
              : <>The simulation applies budgets in gate order: <strong className="text-fg-default">Account</strong> → <strong className="text-fg-default">Cost center</strong> → <strong className="text-fg-default">User level</strong> → <strong className="text-fg-default">Product</strong>. Whichever limit is hit first blocks later requests for that scope.</>}
          </p>
          <button
            type="button"
            className="px-4 py-2 text-[13px] font-medium border border-transparent rounded-md bg-bg-success-emphasis text-fg-on-emphasis cursor-pointer hover:opacity-90 disabled:opacity-50 disabled:cursor-default self-start sm:self-auto"
            onClick={onApplyBudgetSimulation}
            disabled={
              isApplyingBudgetSimulation
              || !hasVisibleBudgetValue
            }
          >
            {isApplyingBudgetSimulation ? 'Applying…' : 'Apply'}
          </button>
        </div>

        {budgetSimulationError && (
          <div className="py-3 px-4 rounded-md bg-bg-danger-muted text-fg-danger border border-border-danger text-sm" role="status">
            <span>⚠️ {budgetSimulationError}</span>
          </div>
        )}

        {budgetSimulation && (
          <div className="bg-bg-default border border-border-default rounded-md px-5 py-5 flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <strong className="text-sm font-semibold text-fg-default">Budget simulation</strong>
              <p className="m-0 text-[13px] text-fg-muted">
                Simulated AIC additional usage bill: <strong className="text-fg-default">{formatUsd(budgetSimulation.totalBill)}</strong>
                {budgetSimulation.budgetExhausted
                  ? isIndividualReport
                    ? ' after the additional usage budget was exhausted.'
                    : ' after the account additional spend budget was exhausted.'
                  : isIndividualReport
                    ? ' after applying the configured additional usage budget.'
                    : ' after applying the configured user, account, and product budget limits.'}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              <SimulationSummaryCard
                label="Simulated additional usage bill"
                value={formatUsd(budgetSimulation.totalBill)}
              />
              {!isIndividualReport && (
                <SimulationSummaryCard
                  label="Blocked users"
                  value={budgetSimulation.blockedUsers.toLocaleString()}
                />
              )}
              <SimulationSummaryCard
                label="Blocked PRUs"
                value={budgetSimulation.blockedRequests.toLocaleString()}
              />
              {!isIndividualReport && (
                <SimulationSummaryCard
                  label="Included credits blocked by user budgets"
                  value={formatAic(budgetSimulation.blockedIncludedCreditsAic)}
                />
              )}
            </div>

            <div className="flex flex-col gap-1 text-[13px] text-fg-muted leading-normal">
              {!isIndividualReport && (
                <p className="m-0">
                  First user-level budget block: <strong className="text-fg-default">{formatSimulationDate(budgetSimulation.firstUserBlockedDate)}</strong>
                </p>
              )}
              <p className="m-0">
                {isIndividualReport ? 'Additional usage budget' : 'Account-level budget'} blocked all remaining usage: <strong className="text-fg-default">{formatSimulationDate(budgetSimulation.accountBlockedDate)}</strong>
              </p>
              {!isIndividualReport && PRODUCT_SIMULATION_DETAILS.map((product) => (
                <p key={product.key} className="m-0">
                  {product.label} budget block: <strong className="text-fg-default">{formatSimulationDate(budgetSimulation.productBlockedDates[product.key] ?? null)}</strong>
                </p>
              ))}
              {!isIndividualReport && Object.entries(budgetSimulation.costCenterBlockedDates).map(([ccName, date]) => (
                <p key={ccName} className="m-0">
                  Cost center <strong className="text-fg-default">{ccName}</strong> budget block: <strong className="text-fg-default">{formatSimulationDate(date)}</strong>
                </p>
              ))}
            </div>

            {!isIndividualReport && budgetSimulation.costCenterResults.length > 0 && (
              <div className="flex flex-col gap-2">
                <strong className="text-sm font-semibold text-fg-default">Cost center breakdown</strong>
                <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
                  {budgetSimulation.costCenterResults.map((cc: CostCenterSimulationResult) => (
                    <div key={cc.costCenterName} className="bg-bg-muted border border-border-default rounded-md px-4 py-3 flex flex-col gap-1">
                      <span className="text-sm font-semibold text-fg-default">{cc.costCenterName}</span>
                      <span className="text-xs text-fg-muted">Budget: {formatUsd(cc.budgetUsd)} · Consumed: {formatUsd(cc.additionalSpendConsumed)}</span>
                      <span className="text-xs text-fg-muted">Utilization: {cc.utilizationPercent.toFixed(1)}% · Consumption: {cc.consumptionPercent.toFixed(1)}%</span>
                      {cc.exhaustionDate && (
                        <span className="text-xs text-fg-danger">Exhausted: {formatSimulationDate(cc.exhaustionDate)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {cumulativeSimulationSeries && cumulativeSimulationSeries.labels.length > 0 && (
              <DualAxisLineChart
                title="Cumulative AIC additional usage bill: current vs simulated"
                labels={cumulativeSimulationSeries.labels}
                series={[
                  {
                    label: 'Current additional usage bill',
                    color: '#cf222e',
                    data: cumulativeSimulationSeries.current,
                    yAxisID: 'y',
                  },
                  {
                    label: 'Simulated additional usage bill',
                    color: '#54aeff',
                    data: cumulativeSimulationSeries.adjusted,
                    yAxisID: 'y',
                  },
                ]}
                formatYAsCurrency
                height={320}
              />
            )}
          </div>
        )}
      </div>
    </section>
  )
}

type SimulationSummaryCardProps = {
  label: string
  value: string
}

function SimulationSummaryCard({ label, value }: SimulationSummaryCardProps) {
  return (
    <div className="bg-bg-muted border border-border-default rounded-md px-5 py-4 flex flex-col gap-1">
      <span className="text-xs font-medium text-fg-muted uppercase tracking-wider">{label}</span>
      <span className="text-2xl font-bold text-fg-default tabular-nums">{value}</span>
    </div>
  )
}
