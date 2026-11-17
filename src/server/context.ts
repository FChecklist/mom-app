// Builds the request context from the environment. Shared by the Pages Function, the dev server and tests.
import { baseUrlFor, type Ctx, type Env } from './ctx.ts';
import { createCalendars } from './services/calendar-adapters.ts';
import { createMailer } from './services/mail.ts';
import { createPaymentProvider } from './services/payments.ts';

export function buildCtx(env: Env, requestUrl?: string, over: Partial<Ctx> = {}): Ctx {
  const f = over.fetch ?? fetch;
  return {
    env,
    db: env.DB,
    now: () => new Date(),
    mailer: createMailer(env, f),
    calendars: createCalendars(env, f),
    payments: createPaymentProvider(env, f),
    baseUrl: baseUrlFor(env, requestUrl),
    fetch: f,
    ...over,
  };
}
