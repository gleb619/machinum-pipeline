import { defineEventHandler } from 'h3'
import { getDailyCost, getMonthlyCost } from '../../utils/cost-tracker.js'

export default defineEventHandler(async () => {
  const todayStr = new Date().toISOString().split('T')[0] as string

  const dailyUsage = await getDailyCost(todayStr)
  const monthUsage = await getMonthlyCost()

  const dailyBudget = Number.parseFloat(process.env.MT_DAILY_BUDGET || '5.00')

  return {
    today: dailyUsage,
    month: monthUsage,
    budgetRemaining: Math.max(0, dailyBudget - dailyUsage.totalCost),
    budgetLimit: dailyBudget,
  }
})
