import { defineEventHandler } from 'h3'
import { getDailyCost, getMonthlyCost } from '../../utils/cost-tracker.js'
import { getRouterConfig } from '../../utils/router-config.js'

export default defineEventHandler(async () => {
  const todayStr = new Date().toISOString().split('T')[0] as string

  const dailyUsage = await getDailyCost(todayStr)
  const monthUsage = await getMonthlyCost()

  const dailyBudget = getRouterConfig().dailyBudget

  return {
    today: dailyUsage,
    month: monthUsage,
    budgetRemaining: Math.max(0, dailyBudget - dailyUsage.totalCost),
    budgetLimit: dailyBudget,
    clientBudgetLimit: getRouterConfig().clientBudget ?? null,
    clients: dailyUsage.clients,
  }
})
