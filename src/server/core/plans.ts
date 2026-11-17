// Pricing. Amounts live ONLY here (server side); the browser can never choose a price.
export const MAX_USERS = 10;
export const TRIAL_DAYS = 14;
export const PAYEE = 'IT SERVICES BY RAJAT AGARWAL';

export const PLANS = {
  monthly: { id: 'monthly', label: 'Rs 499 per month', amountPaise: 49900, days: 30, maxUsers: MAX_USERS },
  yearly: { id: 'yearly', label: 'Rs 4,999 for 12 months', amountPaise: 499900, days: 365, maxUsers: MAX_USERS },
} as const;
export type PlanId = keyof typeof PLANS;
export const isPlan = (p: unknown): p is PlanId => typeof p === 'string' && Object.prototype.hasOwnProperty.call(PLANS, p);

export interface OrgPlanFacts {
  trial_ends_at: string;
  plan: string | null;
  plan_until: string | null;
}
export function planStatus(org: OrgPlanFacts, now: Date): { state: 'trial' | 'active' | 'expired'; until: string } {
  if (org.plan && org.plan_until && Date.parse(org.plan_until) > now.getTime()) return { state: 'active', until: org.plan_until };
  if (Date.parse(org.trial_ends_at) > now.getTime()) return { state: 'trial', until: org.trial_ends_at };
  return { state: 'expired', until: org.plan_until || org.trial_ends_at };
}
