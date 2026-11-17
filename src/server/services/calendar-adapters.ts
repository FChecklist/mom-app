// Google / Microsoft calendar adapters. Without client credentials they run in MOCK mode:
// "connecting" records a mock link and "adding to calendar" records a fake event id; nothing leaves the server.
// With credentials they use plain OAuth2 + REST (fetch only, no SDKs) and request calendar scope only.
import type { Env } from '../ctx.ts';
import { HttpError, rid } from '../util.ts';

export type ProviderId = 'google' | 'microsoft';
export const PROVIDER_IDS: ProviderId[] = ['google', 'microsoft'];
export const isProviderId = (p: unknown): p is ProviderId => p === 'google' || p === 'microsoft';

export interface CalEventInput {
  title: string;
  /** All-day event on this date (YYYY-MM-DD). */
  date: string;
  description: string;
}
export interface CalendarProvider {
  id: ProviderId;
  label: string;
  mode: 'mock' | 'live';
  authUrl(state: string, redirectUri: string): string;
  exchangeCode(code: string, redirectUri: string): Promise<{ account: string; refreshToken: string }>;
  createEvent(refreshToken: string | null, ev: CalEventInput): Promise<{ externalId: string }>;
}

const nextDay = (d: string) => new Date(Date.parse(d + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);

function mockProvider(id: ProviderId, label: string): CalendarProvider {
  return {
    id,
    label,
    mode: 'mock',
    authUrl() {
      throw new HttpError(400, 'MOCK_MODE', 'This provider runs in mock mode; there is no sign-in page.');
    },
    async exchangeCode() {
      throw new HttpError(400, 'MOCK_MODE', 'This provider runs in mock mode.');
    },
    async createEvent() {
      return { externalId: 'mock_' + id + '_' + rid('e').slice(2) };
    },
  };
}

function google(env: Env, f: typeof fetch): CalendarProvider {
  const cid = env.GOOGLE_CLIENT_ID!, sec = env.GOOGLE_CLIENT_SECRET!;
  const token = async (body: Record<string, string>) => {
    const r = await f('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cid, client_secret: sec, ...body }) });
    if (!r.ok) throw new HttpError(502, 'GOOGLE_ERROR', 'Google did not accept the request. Please try connecting again.');
    return (await r.json()) as { access_token?: string; refresh_token?: string };
  };
  return {
    id: 'google',
    label: 'Google (Gmail / Calendar)',
    mode: 'live',
    authUrl(state, redirectUri) {
      const q = new URLSearchParams({ client_id: cid, redirect_uri: redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: 'openid email https://www.googleapis.com/auth/calendar.events', state });
      return 'https://accounts.google.com/o/oauth2/v2/auth?' + q;
    },
    async exchangeCode(code, redirectUri) {
      const t = await token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
      if (!t.access_token || !t.refresh_token) throw new HttpError(502, 'GOOGLE_ERROR', 'Google did not give long-lived access. Please try again.');
      const u = await f('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: 'Bearer ' + t.access_token } });
      if (!u.ok) throw new HttpError(502, 'GOOGLE_ERROR', 'Google did not tell us which account this is. Please try connecting again.');
      const info = (await u.json()) as { email?: string };
      return { account: info.email || 'google account', refreshToken: t.refresh_token };
    },
    async createEvent(refreshToken, ev) {
      if (!refreshToken) throw new HttpError(409, 'NOT_CONNECTED', 'Please connect Google first.');
      const t = await token({ refresh_token: refreshToken, grant_type: 'refresh_token' });
      if (!t.access_token) throw new HttpError(502, 'GOOGLE_ERROR', 'Google access has expired. Please reconnect.');
      const r = await f('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + t.access_token, 'content-type': 'application/json' },
        body: JSON.stringify({ summary: ev.title, description: ev.description, start: { date: ev.date }, end: { date: nextDay(ev.date) } }),
      });
      if (!r.ok) throw new HttpError(502, 'GOOGLE_ERROR', 'Google could not create the calendar event.');
      const j = (await r.json()) as { id?: string };
      return { externalId: j.id || 'google_event' };
    },
  };
}

function microsoft(env: Env, f: typeof fetch): CalendarProvider {
  const cid = env.MS_CLIENT_ID!, sec = env.MS_CLIENT_SECRET!;
  const base = 'https://login.microsoftonline.com/common/oauth2/v2.0';
  const scope = 'offline_access User.Read Calendars.ReadWrite';
  const token = async (body: Record<string, string>) => {
    const r = await f(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: cid, client_secret: sec, scope, ...body }) });
    if (!r.ok) throw new HttpError(502, 'MICROSOFT_ERROR', 'Microsoft did not accept the request. Please try connecting again.');
    return (await r.json()) as { access_token?: string; refresh_token?: string };
  };
  return {
    id: 'microsoft',
    label: 'Microsoft (Outlook / 365 Calendar)',
    mode: 'live',
    authUrl(state, redirectUri) {
      return base + '/authorize?' + new URLSearchParams({ client_id: cid, redirect_uri: redirectUri, response_type: 'code', scope, state, response_mode: 'query' });
    },
    async exchangeCode(code, redirectUri) {
      const t = await token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
      if (!t.access_token || !t.refresh_token) throw new HttpError(502, 'MICROSOFT_ERROR', 'Microsoft did not give long-lived access. Please try again.');
      const u = await f('https://graph.microsoft.com/v1.0/me', { headers: { authorization: 'Bearer ' + t.access_token } });
      if (!u.ok) throw new HttpError(502, 'MICROSOFT_ERROR', 'Microsoft did not tell us which account this is. Please try connecting again.');
      const info = (await u.json()) as { mail?: string; userPrincipalName?: string };
      return { account: info.mail || info.userPrincipalName || 'microsoft account', refreshToken: t.refresh_token };
    },
    async createEvent(refreshToken, ev) {
      if (!refreshToken) throw new HttpError(409, 'NOT_CONNECTED', 'Please connect Microsoft first.');
      const t = await token({ refresh_token: refreshToken, grant_type: 'refresh_token' });
      if (!t.access_token) throw new HttpError(502, 'MICROSOFT_ERROR', 'Microsoft access has expired. Please reconnect.');
      const r = await f('https://graph.microsoft.com/v1.0/me/events', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + t.access_token, 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: ev.title,
          body: { contentType: 'text', content: ev.description },
          isAllDay: true,
          start: { dateTime: ev.date + 'T00:00:00', timeZone: 'UTC' },
          end: { dateTime: nextDay(ev.date) + 'T00:00:00', timeZone: 'UTC' },
        }),
      });
      if (!r.ok) throw new HttpError(502, 'MICROSOFT_ERROR', 'Microsoft could not create the calendar event.');
      const j = (await r.json()) as { id?: string };
      return { externalId: j.id || 'microsoft_event' };
    },
  };
}

export function createCalendars(env: Env, f: typeof fetch = fetch): Record<ProviderId, CalendarProvider> {
  return {
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? google(env, f) : mockProvider('google', 'Google (Gmail / Calendar)'),
    microsoft: env.MS_CLIENT_ID && env.MS_CLIENT_SECRET ? microsoft(env, f) : mockProvider('microsoft', 'Microsoft (Outlook / 365 Calendar)'),
  };
}
