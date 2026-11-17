// The one place that decides whether a team may still write (only when ENFORCE_PLAN=1 and the trial/plan has ended).
import type { Ctx } from '../ctx.ts';
import { planStatus } from '../core/plans.ts';
import { HttpError } from '../util.ts';
import type { OrgRow } from './auth.ts';

export function assertWritable(ctx: Ctx, org: OrgRow) {
  if (ctx.env.ENFORCE_PLAN === '1' && planStatus(org, ctx.now()).state === 'expired') {
    throw new HttpError(402, 'PLAN_EXPIRED', 'Your free trial has ended. Please choose a plan to keep adding and changing MOMs. Everything you wrote is safe.');
  }
}
