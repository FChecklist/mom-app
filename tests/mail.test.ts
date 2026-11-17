import { describe, expect, test } from 'bun:test';
import { createMailer, fromObject, mailBudgets, parseSender, FORBIDDEN_SENDER_LOCALPARTS, senderLocalPart, sendMail } from '../src/server/services/mail.ts';
import { makeApp } from './helpers.ts';

function appWithResend(extra: Record<string, string> = {}, status = 200) {
  const sent: any[] = [];
  const app = makeApp({ RESEND_API_KEY: 're_test_KEY_DO_NOT_LEAK', MAIL_FROM: 'MOM <noreply@mom.test>', ...extra }, (async (url: any, init: any) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status });
  }) as any);
  return { app, sent };
}
const send = async (app: any, n = 1, kind: any = 'notice') => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await sendMail(app.ctx, { to: `u${i}@x.test`, subject: 's', text: 't', kind }));
  return out;
};

describe('mail through the existing Resend free-limit set-up', () => {
  test('without a key nothing is sent, it is only recorded', async () => {
    const app = makeApp();
    expect(app.ctx.mailer.id).toBe('mock');
    expect(await sendMail(app.ctx, { to: 'a@b.test', subject: 's', text: 't', kind: 'notice' })).toBe('recorded');
    expect(app.outbox()[0]).toMatchObject({ status: 'recorded', provider: 'mock' });
    expect(app.fetchCalls.length).toBe(0);
  });

  test('with a key it posts to Resend, as the configured sender, and records "sent"', async () => {
    const { app, sent } = appWithResend();
    expect(await sendMail(app.ctx, { to: 'a@b.test', subject: 'Hello', text: 'Body', kind: 'notice' })).toBe('sent');
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe('https://api.resend.com/emails');
    expect(sent[0].init.headers.authorization).toBe('Bearer re_test_KEY_DO_NOT_LEAK');
    expect(JSON.parse(sent[0].init.body)).toEqual({ from: 'MOM <noreply@mom.test>', to: ['a@b.test'], subject: 'Hello', text: 'Body' });
  });

  test('the daily cap protects the free limit; codes and notices have separate budgets so neither can starve the other', async () => {
    const { app, sent } = appWithResend({ MAIL_DAILY_CAP: '4', CODE_DAILY_CAP: '2' });
    expect(await send(app, 4)).toEqual(['sent', 'sent', 'capped', 'capped']); // notices: 4 - 2 = 2
    expect(sent.length).toBe(2);
    expect(await send(app, 3, 'code')).toEqual(['sent', 'sent', 'capped']); // codes: their own 2, untouched by the notice spam
    expect(sent.length).toBe(4);
    app.advance(86400000);
    expect(await sendMail(app.ctx, { to: 'd@x.test', subject: 's', text: 't', kind: 'notice' })).toBe('sent'); // new day
  });

  test('the forbidden sender and a missing sender are refused before anything leaves', async () => {
    const a = appWithResend({ MAIL_FROM: 'Tina <tina@lucifertech.test>' });
    expect(FORBIDDEN_SENDER_LOCALPARTS).toContain('tina');
    expect((await send(a.app))[0]).toBe('failed');
    expect(a.sent.length).toBe(0);
    const b = appWithResend({ MAIL_FROM: '' });
    expect((await send(b.app))[0]).toBe('failed');
    expect(b.sent.length).toBe(0);
    expect(senderLocalPart('MOM <No.Reply@x.test>')).toBe('no.reply');
    expect(senderLocalPart('tina@x.test')).toBe('tina');
  });

  test('a Resend error is recorded without leaking the key, and the app carries on', async () => {
    const { app } = appWithResend({}, 500);
    expect((await send(app))[0]).toBe('failed');
    const row = app.outbox()[0] as any;
    expect(row.error).toBe('Resend answered 500');
    expect(JSON.stringify(app.raw.query('SELECT * FROM outbox').all())).not.toContain('KEY_DO_NOT_LEAK');
  });

  test('the Resend mailer can be created on its own and only talks to api.resend.com', async () => {
    let seen = '';
    const m = createMailer({ RESEND_API_KEY: 're_test_key_1234' } as any, (async (u: any) => { seen = String(u); return new Response('{}'); }) as any);
    await m.send({ from: 'a@b.test', to: 'c@d.test', subject: 's', text: 't' });
    expect(seen).toBe('https://api.resend.com/emails');
  });
});

describe('mail through the free Cloudflare Email Service (the default provider)', () => {
  const ACC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const TOKEN = 'cf_test_TOKEN_DO_NOT_LEAK';
  function appWithCf(extra: Record<string, string | undefined> = {}, answer: () => Response = () => new Response(JSON.stringify({ success: true, result: { delivered: ['x'], queued: [], permanent_bounces: [] } }), { status: 200 })) {
    const sent: any[] = [];
    const app = makeApp({ CF_EMAIL_TOKEN: TOKEN, CF_ACCOUNT_ID: ACC, MAIL_FROM: 'Townhall Records <no-reply@townhall-records.com>', ...extra } as any, (async (url: any, init: any) => { sent.push({ url: String(url), init }); return answer(); }) as any);
    return { app, sent };
  }

  test('with the two Cloudflare secrets it posts to api.cloudflare.com only, with a display-name sender, and records "sent"', async () => {
    const { app, sent } = appWithCf();
    expect(app.ctx.mailer.id).toBe('cloudflare');
    expect(await sendMail(app.ctx, { to: 'a@b.test', subject: 'Hello', text: 'Body', kind: 'notice' })).toBe('sent');
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACC}/email/sending/send`);
    expect(sent[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(sent[0].init.redirect).toBe('manual');
    expect(JSON.parse(sent[0].init.body)).toEqual({ from: { address: 'no-reply@townhall-records.com', name: 'Townhall Records' }, to: ['a@b.test'], subject: 'Hello', text: 'Body' });
    expect(app.outbox()[0]).toMatchObject({ status: 'sent', provider: 'cloudflare' });
  });

  test('it wins over Resend when both are set; a token without a proper account id counts as not set', async () => {
    const both = appWithCf({ RESEND_API_KEY: 're_test_key_1234' });
    expect(both.app.ctx.mailer.id).toBe('cloudflare');
    const bad = appWithCf({ CF_ACCOUNT_ID: 'not-an-id' });
    expect(bad.app.ctx.mailer.id).toBe('mock');
    const none = appWithCf({ CF_EMAIL_TOKEN: undefined });
    expect(none.app.ctx.mailer.id).toBe('mock');
    const resendOnly = appWithCf({ CF_EMAIL_TOKEN: undefined, RESEND_API_KEY: 're_test_key_1234' });
    expect(resendOnly.app.ctx.mailer.id).toBe('resend');
  });

  test('daily caps, the forbidden sender and a missing sender work the same as before', async () => {
    const { app, sent } = appWithCf({ MAIL_DAILY_CAP: '4', CODE_DAILY_CAP: '2' });
    expect(await send(app, 4)).toEqual(['sent', 'sent', 'capped', 'capped']);
    expect(sent.length).toBe(2);
    const a = appWithCf({ MAIL_FROM: 'Tina <tina@lucifertech.test>' });
    expect((await send(a.app))[0]).toBe('failed'); expect(a.sent.length).toBe(0);
    const b = appWithCf({ MAIL_FROM: '' });
    expect((await send(b.app))[0]).toBe('failed'); expect(b.sent.length).toBe(0);
  });

  test('an error, a refusal or a delivery to nobody is recorded as failed, never sent, and the token never appears', async () => {
    for (const ans of [
      () => new Response('{}', { status: 500 }),
      () => new Response(JSON.stringify({ success: false, errors: [{ code: 1 }] }), { status: 200 }),
      () => new Response(JSON.stringify({ success: true, result: { delivered: [], queued: [] } }), { status: 200 }),
      () => new Response('', { status: 302, headers: { location: 'https://evil.test/' } }),
    ]) {
      const { app, sent } = appWithCf({}, ans);
      expect((await send(app))[0]).toBe('failed');
      expect(sent.length).toBe(1); // never followed anywhere else
      expect(JSON.stringify(app.raw.query('SELECT * FROM outbox').all())).not.toContain('DO_NOT_LEAK');
    }
  });

  test('the sender display name cannot break the header or smuggle anything', () => {
    expect(fromObject('Townhall Records <no-reply@townhall-records.com>')).toEqual({ address: 'no-reply@townhall-records.com', name: 'Townhall Records' });
    expect(fromObject('x@y.test')).toBe('x@y.test');
    expect(fromObject('A "B"\ C\r\nBcc: evil@x.test <a@b.test>')).toEqual({ address: 'a@b.test', name: 'A B C Bcc: evil@x.test' });
    expect(fromObject('<a@b.test>')).toBe('a@b.test');
  });

  test('production sign-in works through Cloudflare mail and the outbox keeps no body', async () => {
    const { app } = appWithCf({ MOM_MODE: 'production', PUBLIC_BASE_URL: undefined as any, SESSION_SECRET: 'prod-test-secret-0123456789abcdef' });
    const r = await app.browser().post('/api/auth/start', { email: 'ann@team.test' });
    expect(r.status).toBe(200);
    const row = app.raw.query("SELECT body, provider, status FROM outbox WHERE kind = 'code'").get() as any;
    expect(row).toMatchObject({ provider: 'cloudflare', status: 'sent', body: '[not kept]' });
  });
});

describe('mail provider: audit fixes', () => {
  const ACC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const mk = (extra: Record<string, string | undefined> = {}, answer?: () => Response) => {
    const sent: any[] = [];
    const app = makeApp({ CF_EMAIL_TOKEN: 'cf_test_TOKEN_DO_NOT_LEAK', CF_ACCOUNT_ID: ACC, MAIL_FROM: 'MOM <noreply@mom.test>', ...extra } as any, (async (url: any, init: any) => { sent.push({ url: String(url), init }); if (answer) return answer(); return new Response(JSON.stringify({ success: true, result: { delivered: ['x'], queued: [] } }), { status: 200 }); }) as any);
    return { app, sent };
  };

  test('a damaged token (smart quote, line break inside, too short) counts as not set, so it can never reach a header or the outbox', async () => {
    for (const tok of ['cf_test_\u201cTOKEN_DO_NOT_LEAK', 'cf_test_TOKEN\r\nX-Evil: 1', 'short', '   ']) {
      const { app, sent } = mk({ CF_EMAIL_TOKEN: tok });
      expect(app.ctx.mailer.id).toBe('mock');
      expect((await send(app))[0]).toBe('recorded'); // mock in the test app (dev); in production it fails closed (next test)
      expect(sent.length).toBe(0);
    }
    // a harmless trailing line break (a pasted secret) is trimmed away
    expect(mk({ CF_EMAIL_TOKEN: '\uFEFFcf_test_TOKEN_DO_NOT_LEAK\n' }).app.ctx.mailer.id).toBe('cloudflare'); // a BOM or a line break at the ends is trimmed away
  });

  test('a runtime error is never stored with its own text, only a fixed one', async () => {
    const m = createMailer({ CF_EMAIL_TOKEN: 'cf_test_TOKEN_DO_NOT_LEAK', CF_ACCOUNT_ID: ACC } as any, (async () => { throw new TypeError("Header '14' has invalid value: 'Bearer cf_test_TOKEN_DO_NOT_LEAK'"); }) as any);
    const app = makeApp({ CF_EMAIL_TOKEN: 'cf_test_TOKEN_DO_NOT_LEAK', CF_ACCOUNT_ID: ACC, MAIL_FROM: 'MOM <noreply@mom.test>' } as any, (async () => { throw new TypeError("Header '14' has invalid value: 'Bearer cf_test_TOKEN_DO_NOT_LEAK'"); }) as any);
    expect((await send(app))[0]).toBe('failed');
    const row = app.outbox()[0] as any;
    expect(row.error).toBe('send failed (network, timeout or request error)');
    expect(JSON.stringify(app.raw.query('SELECT * FROM outbox').all())).not.toContain('DO_NOT_LEAK');
    await expect(m.send({ from: 'a@b.test', to: 'c@d.test', subject: 's', text: 't' })).rejects.toBeDefined();
  });

  test('a permanent bounce for the recipient, or errors beside success, are failures, not "sent"', async () => {
    for (const body of [
      { success: true, result: { delivered: [], queued: [], permanent_bounces: ['u0@x.test'] } },
      { success: true, result: { permanent_bounces: [{ address: 'U0@x.test' }] } },
      { success: true, errors: [{ code: 1 }], result: { delivered: ['u0@x.test'], queued: [] } },
    ]) {
      const { app } = mk({}, () => new Response(JSON.stringify(body), { status: 200 }));
      expect((await send(app))[0]).toBe('failed');
    }
  });

  test('MAIL_FROM must be exactly one valid address: tricks around the blocked sender name and several addresses are refused before anything leaves', async () => {
    for (const from of ['"x <ok@y.test>" <tina@z.test>', 'Ok <ok@x.test>, tina@x.test', '<ok@x.test> <tina@x.test>', 'tina+news@x.test', 'Tina <TINA@x.test>', 'a@b.test, c@d.test', 'no-at-sign', 'A <a@b.test> trailing']) {
      const { app, sent } = mk({ MAIL_FROM: from });
      expect((await send(app))[0]).toBe('failed');
      expect(sent.length).toBe(0);
    }
    expect(parseSender('Townhall <a.b+c@x.test>')).toEqual({ address: 'a.b+c@x.test', name: 'Townhall' });
    expect(senderLocalPart('Tina <tina+x@x.test>')).toBe('tina');
  });

  test('a cap that is not a number does not switch the cap off', () => {
    expect(mailBudgets({ MAIL_DAILY_CAP: 'abc' } as any).total).toBe(90);
    expect(mailBudgets({ MAIL_DAILY_CAP: '10', CODE_DAILY_CAP: 'x' } as any)).toEqual({ total: 10, codes: 6, notices: 4 });
  });

  test('in production a damaged token with no fallback fails closed: sign-in says e-mail is not switched on and nothing is fetched', async () => {
    const { app, sent } = mk({ MOM_MODE: 'production', PUBLIC_BASE_URL: undefined as any, SESSION_SECRET: 'prod-test-secret-0123456789abcdef', CF_EMAIL_TOKEN: 'cf_test_\u201cTOKEN_DO_NOT_LEAK' });
    const r = await app.browser().post('/api/auth/start', { email: 'ann@team.test' });
    expect(r.status).toBe(503);
    expect(sent.length).toBe(0);
  });
});
