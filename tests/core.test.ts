import { describe, expect, test } from 'bun:test';
import { canContribute, canManageMom, canView, canWorkOnPoint, momRole } from '../src/server/core/permissions.ts';
import { isPlan, PLANS, planStatus } from '../src/server/core/plans.ts';
import { allowedNext, canTransition, isClosed, isStatus, isStruck, STATUS_META, STATUSES } from '../src/server/core/status.ts';
import { makePdf, momPdf } from '../src/server/core/pdf.ts';
import { decryptText, encryptText } from '../src/server/core/crypto.ts';
import { fmtDate, fmtDateTime, isoDateOnly, normEmail, requireEmail, HttpError, safeUrl, str } from '../src/server/util.ts';

describe('statuses', () => {
  test('exactly the four required statuses, each with its own colour and symbol', () => {
    expect([...STATUSES]).toEqual(['Complete', 'WIP', 'In progress', 'Discarded']);
    const colours = new Set(STATUSES.map((s) => STATUS_META[s].colour));
    const syms = new Set(STATUSES.map((s) => STATUS_META[s].sym));
    expect(colours.size).toBe(4);
    expect(syms.size).toBe(4);
  });
  test('Complete and Discarded are struck through, the others are not', () => {
    expect(isStruck('Complete')).toBe(true);
    expect(isStruck('Discarded')).toBe(true);
    expect(isStruck('WIP')).toBe(false);
    expect(isStruck('In progress')).toBe(false);
    expect(isClosed('Complete') && isClosed('Discarded') && !isClosed('WIP')).toBe(true);
  });
  test('moves: open points move freely, closed points reopen one careful step', () => {
    expect(canTransition('WIP', 'In progress')).toBe(true);
    expect(canTransition('In progress', 'Complete')).toBe(true);
    expect(canTransition('Complete', 'Discarded')).toBe(false);
    expect(canTransition('Complete', 'In progress')).toBe(true);
    expect(canTransition('Discarded', 'WIP')).toBe(true);
    expect(canTransition('Discarded', 'Complete')).toBe(false);
    expect(canTransition('WIP', 'WIP')).toBe(false);
    expect(allowedNext('Complete')).toEqual(['In progress']);
    expect(isStatus('Done')).toBe(false);
  });
});

describe('permissions', () => {
  const org = 'o1';
  const mom = (status: 'draft' | 'published') => ({ org_id: org, created_by: 'maker@x.test', status });
  const user = (email: string, role: 'owner' | 'member' = 'member', o = org) => ({ email, org_id: o, role });
  test('creator and team owner manage; participants only see published MOMs', () => {
    expect(momRole(user('maker@x.test'), mom('draft'), [])).toBe('owner');
    expect(momRole(user('boss@x.test', 'owner'), mom('draft'), [])).toBe('owner');
    expect(momRole(user('p@x.test'), mom('draft'), ['p@x.test'])).toBe('none');
    expect(momRole(user('p@x.test'), mom('published'), ['p@x.test'])).toBe('participant');
    expect(momRole(user('q@x.test'), mom('published'), ['p@x.test'])).toBe('none');
    expect(momRole(user('maker@x.test', 'owner', 'other'), mom('published'), [])).toBe('none');
  });
  test('capabilities', () => {
    expect(canManageMom('owner') && !canManageMom('participant') && !canManageMom('guest')).toBe(true);
    expect(canContribute('participant') && !canContribute('guest')).toBe(true);
    expect(canView('guest') && !canView('none')).toBe(true);
    expect(canWorkOnPoint('participant', 'a@x.test', ['a@x.test'])).toBe(true);
    expect(canWorkOnPoint('participant', 'b@x.test', ['a@x.test'])).toBe(false);
    expect(canWorkOnPoint('guest', 'a@x.test', ['a@x.test'])).toBe(false);
  });
});

describe('pricing and plans', () => {
  test('prices are exactly Rs 499 per month and Rs 4,999 for 12 months, up to 10 users', () => {
    expect(PLANS.monthly.amountPaise).toBe(49900);
    expect(PLANS.yearly.amountPaise).toBe(499900);
    expect(PLANS.monthly.maxUsers).toBe(10);
    expect(PLANS.yearly.days).toBe(365);
    expect(isPlan('monthly') && isPlan('yearly') && !isPlan('free') && !isPlan('__proto__')).toBe(true);
  });
  test('trial, active and expired', () => {
    const now = new Date('2026-11-11T00:00:00Z');
    expect(planStatus({ trial_ends_at: '2026-11-20T00:00:00Z', plan: null, plan_until: null }, now).state).toBe('trial');
    expect(planStatus({ trial_ends_at: '2026-11-01T00:00:00Z', plan: null, plan_until: null }, now).state).toBe('expired');
    expect(planStatus({ trial_ends_at: '2026-11-01T00:00:00Z', plan: 'monthly', plan_until: '2026-12-01T00:00:00Z' }, now).state).toBe('active');
    expect(planStatus({ trial_ends_at: '2026-11-01T00:00:00Z', plan: 'monthly', plan_until: '2026-11-05T00:00:00Z' }, now).state).toBe('expired');
  });
});

describe('util', () => {
  test('e-mail only: mobile numbers are refused kindly, bad addresses too', () => {
    expect(requireEmail(' Asha@Example.COM ')).toBe('asha@example.com');
    for (const bad of ['+91 98765 43210', '9876543210']) {
      try { requireEmail(bad); throw new Error('should fail'); } catch (e) { expect((e as HttpError).code).toBe('EMAIL_ONLY'); }
    }
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'a@b.c', 'x,y@z.com']) {
      try { requireEmail(bad); throw new Error('should fail ' + bad); } catch (e) { expect((e as HttpError).code).toBe('BAD_EMAIL'); }
    }
    expect(normEmail(undefined)).toBe('');
  });
  test('dates and strings', () => {
    expect(fmtDate('2026-12-31')).toBe('31 Dec 2026');
    expect(fmtDateTime('2026-11-11T06:00:00Z')).toBe('11 Nov 2026 at 11:30 am'); // IST
    expect(() => isoDateOnly('2026-13-40', 'the date')).toThrow();
    expect(() => isoDateOnly('11/11/2026', 'the date')).toThrow();
    expect(() => str('x'.repeat(5), 3, 'f')).toThrow();
    expect(() => str('', 3, 'f', { required: true })).toThrow();
    expect(safeUrl('https://a.test/x')).toBe('https://a.test/x');
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('ftp://a.test')).toBe('');
  });
});

describe('pdf', () => {
  function checkPdf(b: Uint8Array) {
    const s = String.fromCharCode(...b);
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(xref, xref + 4)).toBe('xref');
    // every object starts exactly where the table says
    const rows = s.slice(xref).split('\n').slice(3).filter((l) => /^\d{10} 00000 n/.test(l));
    rows.forEach((r, i) => expect(s.slice(Number(r.slice(0, 10))).startsWith(`${i + 1} 0 obj`)).toBe(true));
    return s;
  }
  test('a long document produces a structurally valid multi-page PDF', () => {
    const items = Array.from({ length: 120 }, (_, i) => ({ t: `Line ${i} with (brackets) and \\ backslash and a very long tail ${'word '.repeat(30)}`, s: 11 }));
    const s = checkPdf(makePdf(items));
    expect(/\/Count (\d+)/.exec(s)![1]).not.toBe('1');
  });
  test('a MOM PDF shows struck-through closed points, owners and history', () => {
    const s = checkPdf(momPdf({
      title: 'Budget (draft)', date: '2026-11-11', venue: 'Hall', status: 'published', version: 3, notes: 'n', attendeeNames: ['Asha', 'Ravi'],
      points: [{ no: 1, title: 'Pay vendor', status: 'Complete', ownerNames: ['Asha', 'Ravi'], due: '2026-11-20' }, { no: 2, title: 'Book hall', status: 'WIP', ownerNames: ['Ravi'], due: '' }],
      history: [{ v: 1, what: 'Created → done', byName: 'Asha', at: '2026-11-11T06:00:00Z' }], host: 'mom.test',
    }));
    expect(s).toContain('Pay vendor');
    expect(s).toContain('Asha, Ravi');
    expect(s).toContain('->'); // the arrow is written in plain ASCII
    expect((s.match(/ m .* l S Q/g) || []).length).toBe(1); // only the Complete point is struck through
  });
});

describe('token encryption', () => {
  test('round trip, and the wrong key fails', async () => {
    const blob = await encryptText('k1', 'refresh-token-value');
    expect(blob).not.toContain('refresh');
    expect(await decryptText('k1', blob)).toBe('refresh-token-value');
    await expect(decryptText('k2', blob)).rejects.toBeDefined();
    expect(await encryptText('k1', 'x')).not.toBe(await encryptText('k1', 'x')); // fresh IV each time
  });
});
