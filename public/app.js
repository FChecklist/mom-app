// MOM v2 screens. All data comes from the real API (/api/...). Plain JavaScript, no build step.
(function () {
  'use strict';
  var U = window.MOMU, ST = U.STATUS, SL = U.STATUS_LIST, fD = U.fmtD, fT = U.fmtT, fDT = U.fmtDT;
  var S = { me: null, guest: null, guestMom: null, users: [], moms: [], points: [], org: null };
  var CFG = { host: 'mom.veridian-aios.com', mode: 'production', devMail: false, payments: { provider: 'mock', mode: 'mock', ready: false }, plans: [], maxUsers: 10, trialDays: 14, payee: 'IT SERVICES BY RAJAT AGARWAL' };
  var ui = { asGuest: readGuest(), f: 'all', who: 'all', merge: false, sel: [], att: { kind: 'text' }, shareTab: 'email', si: { step: 1, email: '', name: '', team: '', dev: '' }, sh: { step: 1, email: '', token: '', info: null, dev: '' }, lastRoute: '', cache: {}, busy: false, loaded: false, shareLink: null };
  var STEPS = [['Create', '✎', '--c-create', 'Name it and date it'], ['Add points', '☰', '--c-points', 'Add what needs doing'], ['Publish', '↑', '--c-publish', 'Make it official'], ['Share', '➤', '--c-share', 'Send by e-mail or WhatsApp'], ['Follow up', '◎', '--c-follow', 'Tick points off together']];
  var PAL = ['#6c4bd6', '#1f6fe0', '#0e8f6e', '#d6336c', '#e8710a', '#0e7c6e', '#7a4ac9', '#2b8a3e'];
  var ICON = { text: '📝', url: '🌐', link: '🔗', pdf: '📄', image: '🖼️' };
  var KIND = { text: 'Text note', url: 'Web address', link: 'Link', pdf: 'PDF', image: 'Image' };
  var MAX_FILE = 1000000;

  // ---------- api ----------
  // A person who is signed in AND opens someone else's link must keep their own session: the guest view is a separate
  // cookie and is asked for explicitly with ?as=guest. The browser remembers which view this tab is in.
  function readGuest() { try { return sessionStorage.getItem('mom_as_guest') === '1'; } catch (e) { return false; } }
  function setGuest(on) { ui.asGuest = !!on; try { if (on) sessionStorage.setItem('mom_as_guest', '1'); else sessionStorage.removeItem('mom_as_guest'); } catch (e) { /* private window */ } }
  function asq(path) {
    if (!ui.asGuest || /^\/api\/(auth|config|shared)(\/|$|\?)/.test(path)) return path;
    return path + (path.indexOf('?') > -1 ? '&' : '?') + 'as=guest';
  }
  function rkey() {
    var c = 'abcdefghijklmnopqrstuvwxyz0123456789', a = new Uint8Array(22), o = 'k';
    try { crypto.getRandomValues(a); } catch (e) { for (var j = 0; j < a.length; j++) a[j] = Math.floor(Math.random() * 256); }
    for (var i = 0; i < a.length; i++) o += c[a[i] % c.length];
    return o;
  }
  var DEAD = { me: null, guest: null, guestMom: null, users: [], moms: [], points: [], org: null };
  function api(method, path, body) {
    var o = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(body); }
    // Every change carries a one-time key: if the network drops and we try again, or a finger taps twice, the server
    // answers with the first result instead of doing it a second time.
    var safeToRepeat = method !== 'GET' && !/^\/api\/(auth|shared)\//.test(path);
    // Confirming a payment is safe to repeat on the server (a payment counts once), so it carries no one-time key: a retry then always reaches the real answer, never a "still in progress" one.
    if (safeToRepeat && path !== '/api/billing/verify') o.headers['idempotency-key'] = rkey();
    function handle(r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not json */ }
        if (!r.ok) {
          var er = (j && j.error) || {}, e = new Error(er.message || 'Something went wrong. Please try again.');
          e.status = r.status; e.code = er.code; e.data = er; throw e;
        }
        return j;
      });
    }
    function attempt(again) {
      return fetch(asq(path), o).then(handle, function () {
        if (again && safeToRepeat) return new Promise(function (res) { setTimeout(res, 700); }).then(function () { return attempt(false); });
        var e = new Error('Could not reach the server. Please check your connection and try again.'); e.status = 0; throw e;
      });
    }
    return attempt(true);
  }
  function load() {
    return api('GET', '/api/state').then(function (s) {
      S = s; ui.loaded = true;
    }, function (e) {
      if (e.status === 401 && ui.asGuest) { setGuest(false); return load(); } // the guest session ended (link expired or cancelled)
      if (e.status === 401) { S = DEAD; ui.loaded = true; return; }
      throw e;
    });
  }
  function refresh(keep) { ui.cache = {}; return load().then(function () { render(keep); }); }

  // ---------- helpers ----------
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function $(id) { return document.getElementById(id); }
  function val(id) { var e = $(id); return e ? e.value.trim() : ''; }
  function user(e) { return S.users.filter(function (u) { return u.email === e; })[0]; }
  function nameFromEmail(e) { return String(e).split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function nm(e) { var u = user(e); return u ? u.name : nameFromEmail(e || ''); }
  function ini(e) { return nm(e).split(/[\s.@]+/).filter(Boolean).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase(); }
  function colr(e) { var h = 0; for (var i = 0; i < e.length; i++) h = (h * 31 + e.charCodeAt(i)) >>> 0; return PAL[h % PAL.length]; }
  function av(e, big) { return '<span class="av' + (big ? ' lg' : '') + '" style="background:' + colr(e) + '" title="' + esc(nm(e)) + '" aria-label="' + esc(nm(e)) + '">' + esc(ini(e)) + '</span>'; }
  function avs(list) { return '<span class="avs">' + list.map(function (e) { return av(e); }).join('') + '</span>'; }
  function names(list) { return list.map(nm).join(', '); }
  function badge(s) { var x = ST[s]; return '<span class="st ' + x.cls + '"><i aria-hidden="true">' + x.sym + '</i>' + esc(s) + '</span>'; }
  function closed(s) { return s === 'Complete' || s === 'Discarded'; }
  function mom(id) { return S.moms.filter(function (m) { return m.id === id; })[0]; }
  function point(id) { return S.points.filter(function (p) { return p.id === id; })[0]; }
  function pts(mid) { return S.points.filter(function (p) { return p.momId === mid; }).sort(function (a, b) { return a.no - b.no; }); }
  function who() { return S.guest || S.me; }
  function isOwner() { return !!(S.org && S.org.isOwner); }
  function canManage(m) { return !!S.me && !!m && m.role === 'owner' && !m.deleted; }
  function canContribute(m) { return !!S.me && !!m && (m.role === 'owner' || m.role === 'participant') && !m.deleted; }
  function canWork(p, m) { return !!S.me && !!m && !m.deleted && (m.role === 'owner' || (m.role === 'participant' && p.resp.indexOf(S.me) > -1)); }
  function overdue(p) { return !closed(p.status) && p.due && p.due < U.D(0); }
  function toast(t) { var e = $('toast'); e.textContent = t; e.className = 'show'; clearTimeout(toast.t); toast.t = setTimeout(function () { e.className = ''; }, 3200); }
  function modal(html) { var m = $('modal'); m.innerHTML = '<div class="sheet">' + html + '</div>'; m.className = 'open'; }
  function closeModal() { $('modal').className = ''; $('modal').innerHTML = ''; }
  function go(h) { if (location.hash === h) render(); else location.hash = h; }
  function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }
  function looksMobile(e) { return /^\+?[\d\s-]{7,}$/.test(e); }
  function safeUrl(u) { return /^https?:\/\//i.test(u) ? u : ''; }
  function emailProblem(e) {
    if (looksMobile(e)) return 'Please use an e-mail ID. E-mail keeps things simple and safe.';
    if (!validEmail(e)) return 'That e-mail looks a little short. Please check it.';
    return '';
  }
  function chipsFor(list, on, cls) {
    return '<div class="chips ' + (cls || '') + '">' + list.map(function (u) { return '<button type="button" class="chip' + (on.indexOf(u.email) > -1 ? ' on' : '') + '" data-act="chip" data-e="' + esc(u.email) + '">' + av(u.email) + ' ' + esc(u.name.split(' ')[0]) + '</button>'; }).join('') + '</div>';
  }
  function pickedChips(sel) { return [].slice.call(document.querySelectorAll(sel + ' .chip.on')).map(function (c) { return c.getAttribute('data-e'); }); }
  function extraEmails(id) {
    var raw = val(id); if (!raw) return [];
    var list = raw.split(/[\s,;]+/).filter(Boolean).map(function (x) { return x.toLowerCase(); });
    for (var i = 0; i < list.length; i++) { var p = emailProblem(list[i]); if (p) throw new Error(p); }
    return list;
  }
  function uniq(a) { return a.filter(function (x, i) { return a.indexOf(x) === i; }); }
  function deletedText(m) { return 'This MOM has been deleted by @' + esc(nm(m.deleted.by)) + ' on ' + fD(m.deleted.at) + ' at ' + fT(m.deleted.at); }
  function need(key, path) {
    if (ui.cache[key] !== undefined) return ui.cache[key];
    ui.cache[key] = null;
    api('GET', path).then(function (d) { ui.cache[key] = d; render(true); }, function (e) { ui.cache[key] = { error: e.message }; render(true); });
    return null;
  }
  var LOADING = '<div class="card c mut">Loading… ⏳</div>';

  // ---------- stepper ----------
  function momStep(m) {
    var p = pts(m.id), shared = m.events.some(function (e) { return e.type === 'share'; });
    if (m.status === 'draft') return p.length ? 3 : 2;
    if (!shared) return 4;
    return p.length && p.every(function (x) { return closed(x.status); }) ? 6 : 5;
  }
  function stepper(cur, noGuide) {
    var h = '<div class="stepper" role="list" aria-label="Steps of a MOM">' + STEPS.map(function (s, i) {
      var k = i + 1, c = k < cur ? 'done' : k === cur ? 'now' : 'todo';
      return '<div class="step ' + c + '" role="listitem" style="--sc:var(' + s[2] + ')"><div class="dot" aria-hidden="true">' + (k < cur ? '✔' : s[1]) + '</div>' + esc(s[0]) + '</div>';
    }).join('') + '</div>';
    if (!noGuide) h += cur > 5 ? '<div class="guide">🎉 Every step is done. Lovely, tidy work.</div>' : '<div class="guide">☝ Step ' + cur + ' of 5, <b>' + STEPS[cur - 1][0] + '</b>: ' + STEPS[cur - 1][3] + '.</div>';
    return h;
  }

  // ---------- shells ----------
  function siteShell(inner) {
    var cta = S.me ? '<a class="btn sf sm" href="#/home">Open MOM</a>' : '<a class="btn sf sm" href="#/signin">Get started</a>';
    return '<header class="top"><a class="brand" href="#/">MOM<b>.</b></a><a class="hl" href="#/pricing">Pricing</a>' + cta + '</header><main class="wrap">' + payBanner() + inner + '</main><footer class="demo">' + esc(CFG.host) + ' &middot; Payments go to ' + esc(CFG.payee) + ' through its secure payment window</footer>';
  }
  function planBanner() {
    var o = S.org; if (!o) return '';
    if (o.plan === 'expired') return o.enforcePlan
      ? '<a class="warn small" style="display:block;text-decoration:none;color:inherit" href="#/billing"><b>Your free trial has ended.</b> You can still read everything. Tap here to choose a plan and keep editing.</a>'
      : '<a class="info small" style="display:block;text-decoration:none;color:inherit" href="#/billing"><b>Your free trial period has ended.</b> Editing is still switched on while we are getting started. Tap to see plans.</a>';
    if (o.plan === 'trial') { var left = Math.max(0, Math.ceil((Date.parse(o.until) - Date.now()) / 86400000)); if (left <= 5) return '<a class="info small" style="display:block;text-decoration:none;color:inherit" href="#/billing">🌱 Free trial: ' + left + ' day' + (left === 1 ? '' : 's') + ' left. Tap to see plans.</a>'; }
    return '';
  }
  function appShell(inner, nav) {
    var h = '<header class="top"><a class="brand" href="#/home">MOM<b>.</b></a>';
    if (S.guest) h += '<span class="small">👁 ' + esc(S.guest) + '</span><button class="btn sm ghost" style="background:#fff" data-act="leave">Leave</button>';
    else if (S.me) h += '<span class="small grow" style="color:#cfe0ee;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(S.org ? S.org.name : '') + '</span>' + av(S.me);
    h += '</header><main class="wrap">' + (S.me ? planBanner() : '') + payBanner() + inner + '</main>';
    if (!S.guest) {
      var n = function (k, href, ic, lab) { return '<a href="' + href + '" class="' + (nav === k ? 'on' : '') + '"><span class="ic" aria-hidden="true">' + ic + '</span>' + lab + '</a>'; };
      h += '<nav class="bnav" aria-label="Main">' + n('home', '#/home', '🏠', 'Home') + n('mine', '#/person/' + encodeURIComponent(S.me), '✔', 'My points') +
        '<a href="#/new" class="plus ' + (nav === 'new' ? 'on' : '') + '"><span class="ic" aria-hidden="true">+</span>New MOM</a>' + n('people', '#/people', '👥', 'People') +
        '<button data-act="more"><span class="ic" aria-hidden="true">⋯</span>More</button></nav>';
    }
    return h;
  }

  // ---------- website ----------
  function planCards(inApp) {
    var plans = CFG.plans.length ? CFG.plans : [{ id: 'monthly', amountPaise: 49900 }, { id: 'yearly', amountPaise: 499900 }];
    var m = plans[0], y = plans[1], save = (m.amountPaise * 12 - y.amountPaise) / 100;
    var owner = S.org && S.org.isOwner, label = function (id, t) { return inApp ? (owner ? t : 'Ask your team owner') : t; };
    var dis = inApp && !owner ? ' disabled' : '';
    return '<div class="price"><div class="tag" style="background:#e0ecff;color:#1d58c4">🌱 Monthly</div><div class="amt">' + U.rs(m.amountPaise) + '</div><div class="mut">per month, for a team of up to ' + CFG.maxUsers + '</div><ul><li>Unlimited MOMs and points</li><li>Full history of every change</li><li>Share by e-mail or WhatsApp</li><li>PDF download</li></ul><button class="btn block" data-act="buy" data-p="monthly"' + dis + '>' + label('monthly', 'Choose monthly') + '</button></div>' +
      '<div class="price best"><div class="tag" style="background:#ffe7c7;color:#a85a00">⭐ Best value</div><div class="amt">' + U.rs(y.amountPaise) + '</div><div class="mut">for 12 months, for a team of up to ' + CFG.maxUsers + '</div><ul><li>Everything in monthly</li><li>' + U.rs(save * 100) + ' less than paying month by month</li><li>One payment, a calm year ahead</li></ul><button class="btn sf block" data-act="buy" data-p="yearly"' + dis + '>' + label('yearly', 'Choose 12 months') + '</button></div>' +
      '<p class="tiny mut c">Payments go through ' + esc(CFG.payee) + '.' + (CFG.payments.mode !== 'live' ? ' <b>Test mode: no real money moves yet.</b>' : '') + ' Every team starts with a ' + CFG.trialDays + '-day free trial.</p>';
  }
  function pricing() { return '<h2 class="c">Simple pricing, kind to your budget</h2><p class="c mut">One plan. Your whole team of up to ' + CFG.maxUsers + '. Plans are prepaid and never renew by themselves, so there is nothing to cancel.</p>' + planCards(false); }
  function viewSite() {
    var feats = [['✔', '#14794a', 'Four clear statuses', 'Complete, WIP, In progress and Discarded, each with its own colour and symbol.'], ['👥', '#1f6fe0', 'Many hands, one point', 'Give a point to several people. See everything one person is handling.'], ['🕒', '#6c4bd6', 'Every version remembered', 'A friendly timeline shows who changed what, and when.'], ['➤', '#d6336c', 'Share in a tap', 'By e-mail or WhatsApp. Each reader confirms their e-mail first.'], ['📄', '#e8710a', 'PDF in one tap', 'A tidy copy to keep, print or forward.']];
    return siteShell('<section class="hero"><span class="host">' + esc(CFG.host) + '</span><h1>Aim to increase your team\'s productivity by 30%*</h1><p>Minutes of meeting that turn into points, owners and follow-ups, simply and warmly. Made for the phone in your hand.</p><div class="row"><a class="btn sf" href="' + (S.me ? '#/home' : '#/signin') + '">' + (S.me ? 'Open MOM' : 'Start free for ' + CFG.trialDays + ' days') + '</a><a class="btn ghost" style="background:transparent;color:#fff;border-color:#fff" href="#/pricing">See pricing</a></div><p class="tiny" style="opacity:.85;margin-top:12px">*Target, results vary.</p></section>' +
      '<h2>How a MOM flows</h2><div class="card">' + stepper(6, true) + '</div><h2>What you get</h2>' +
      feats.map(function (f) { return '<div class="feat"><div class="ic" style="background:' + f[1] + '" aria-hidden="true">' + f[0] + '</div><div><b>' + f[2] + '</b><div class="small mut">' + f[3] + '</div></div></div>'; }).join('') +
      '<div class="card flat" id="price">' + pricing() + '</div>');
  }
  function viewPricing() { return siteShell('<div class="card">' + pricing() + '</div><p class="c"><a href="#/">Back to the home page</a></p>'); }

  // ---------- sign in ----------
  function viewSignin() {
    var si = ui.si, h;
    if (si.step === 1) {
      h = (CFG.mail && CFG.mail.ready === false ? '<div class="warn small"><b>E-mail is not switched on yet,</b> so sign-in codes cannot be sent right now. Please try again later.</div>' : '') + '<h1>Welcome 👋</h1><p class="mut">E-mail is the key to everything here. We will send you a short code.</p><div class="card"><label class="f" for="si-email">Your e-mail ID</label><input id="si-email" type="email" inputmode="email" autocomplete="email" value="' + esc(si.email) + '" placeholder="you@example.com">' +
        '<details class="flat" style="margin-top:8px"' + (si.name || si.team ? ' open' : '') + '><summary class="small"><b>First time here?</b> Tell us a little (optional)</summary><label class="f" for="si-name">Your name</label><input id="si-name" type="text" autocomplete="name" value="' + esc(si.name) + '" placeholder="e.g. Asha Verma"><label class="f" for="si-team">Name of your team</label><input id="si-team" type="text" value="' + esc(si.team) + '" placeholder="e.g. Sunrise Residents"><p class="hint">Your team starts with a ' + CFG.trialDays + '-day free trial.</p></details>' +
        '<button class="btn block" style="margin-top:10px" data-act="si-send">Send me the code ✉</button></div>';
    } else {
      h = '<h1>Check your e-mail ✉</h1><div class="card"><p>We sent a 6-digit code to <b>' + esc(si.email) + '</b>. It works for 10 minutes.</p><label class="f" for="si-code">Code</label><input id="si-code" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="123456">' +
        (si.dev ? '<p class="hint"><span class="mock">DEV</span> No e-mail leaves this computer. Your code is <b>' + esc(si.dev) + '</b>.</p>' : '<p class="hint">Not there yet? Please check the spam folder.</p>') +
        '<button class="btn block" data-act="si-verify">Confirm and open →</button><p class="c small"><a href="#/signin" data-act="si-back">Use a different e-mail</a></p></div>';
    }
    return siteShell(h);
  }

  // ---------- home ----------
  function momCard(m) {
    var p = pts(m.id), done = p.filter(function (x) { return closed(x.status); }).length, pct = p.length ? Math.round(done * 100 / p.length) : 0;
    if (m.deleted) return '<a class="card mc" style="background:#eef0f2" href="#/mom/' + m.id + '"><div class="ttl strike">' + esc(m.title) + '</div><div class="small">🗑 ' + deletedText(m) + '</div></a>';
    var inner = '<div class="row between"><div class="ttl grow">' + esc(m.title) + '</div><span class="tag ' + (m.status === 'published' ? 'pub' : 'drf') + '">' + (m.status === 'published' ? '✔ Published' : '✎ Draft') + '</span></div>' +
      '<div class="small mut">' + fD(m.date) + ' &middot; ' + esc(m.venue) + ' &middot; v' + m.version + '</div>' +
      (m.mergedInto && mom(m.mergedInto) ? '<div class="small" style="color:#5a3ec4">↪ Merged into "' + esc(mom(m.mergedInto).title) + '"</div>' : '') +
      '<div class="row between" style="margin-top:8px">' + avs(m.attendees.slice(0, 5)) + '<span class="small mut">' + done + ' of ' + p.length + ' points closed</span></div><div class="bar" aria-hidden="true"><i style="width:' + pct + '%"></i></div>';
    if (ui.merge) {
      var on = ui.sel.indexOf(m.id) > -1;
      return '<div class="card mc' + (on ? ' sel' : '') + '" data-act="sel" data-id="' + m.id + '" role="checkbox" aria-checked="' + on + '" tabindex="0"><div class="cb"><span class="chip' + (on ? ' on' : '') + '">' + (on ? 'Selected' : 'Tap to select') + '</span></div>' + inner + '</div>';
    }
    return '<a class="card mc" href="#/mom/' + m.id + '">' + inner + '</a>';
  }
  function viewHome() {
    var mine = S.points.filter(function (p) { return p.resp.indexOf(S.me) > -1; });
    var cnt = SL.map(function (s) { var n = mine.filter(function (p) { return p.status === s; }).length; return '<a href="#/person/' + encodeURIComponent(S.me) + '?st=' + encodeURIComponent(s) + '" class="' + ST[s].cls + '"><b>' + n + '</b><span aria-hidden="true">' + ST[s].sym + '</span> ' + s + '</a>'; }).join('');
    var list = S.moms.slice().sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
    var mergeable = S.moms.filter(function (m) { return canManage(m); }).length >= 2;
    var h = '<h1>Namaste, ' + esc(nm(S.me).split(' ')[0]) + ' 🌼</h1><p class="mut">Here is what is on your plate. One tap on a number shows those points.</p><div class="cnt">' + cnt + '</div>' +
      '<div class="row between" style="margin-top:14px"><h2 style="margin:0">Your MOMs</h2>' + (mergeable ? '<button class="btn sm ' + (ui.merge ? 'sf' : 'ghost') + '" data-act="merge-mode">' + (ui.merge ? 'Done selecting' : '⇄ Merge MOMs') + '</button>' : '') + '</div>';
    if (ui.merge) h += '<div class="info small">Tap two or more MOMs, then press Merge. You will see a clear summary before anything happens.</div>';
    h += list.length ? list.map(momCard).join('') : '<div class="card c mut">No MOMs yet. Tap <b>New MOM</b> below to write your first one. 🌱</div>';
    if (ui.merge) h += '<div class="floatbar"><button class="btn sf block" data-act="merge-go"' + (ui.sel.length < 2 ? ' disabled' : '') + '>Merge ' + ui.sel.length + ' selected →</button></div>';
    return appShell(h, 'home');
  }

  // ---------- create / edit MOM ----------
  function viewNew() { return appShell('<h1>New MOM ✎</h1>' + stepper(1) + momForm(null), 'new'); }
  function momForm(m) {
    var att = m ? m.attendees : [S.me];
    return '<div class="card"><label class="f" for="mf-title">Title</label><input id="mf-title" type="text" maxlength="120" value="' + esc(m ? m.title : '') + '" placeholder="e.g. Monthly committee meeting">' +
      '<label class="f" for="mf-date">Date</label><input id="mf-date" type="date" value="' + esc(m ? m.date : U.D(0)) + '">' +
      '<label class="f" for="mf-venue">Where</label><input id="mf-venue" type="text" maxlength="120" value="' + esc(m ? m.venue : '') + '" placeholder="Room, place or Online">' +
      '<label class="f">Who was there</label><div id="mf-att">' + chipsFor(S.users, att) + '</div><p class="hint">Tap names to add or remove. They all receive the MOM by e-mail when you publish.</p>' +
      (isOwner() ? '<label class="f" for="mf-extra">Someone else? Add by e-mail</label><input id="mf-extra" type="text" inputmode="email" placeholder="name@example.com, another@example.com"><p class="hint">They get an invitation to join your team (up to ' + CFG.maxUsers + ' places, invitations included).</p>' : '<p class="hint">Only the team owner can bring new people in.</p>') +
      '<label class="f" for="mf-notes">Notes</label><textarea id="mf-notes" maxlength="4000" placeholder="A few lines about what was discussed">' + esc(m ? m.notes : '') + '</textarea>' +
      '<button class="btn block" data-act="save-mom"' + (m ? ' data-id="' + m.id + '"' : '') + '>' + (m ? 'Save changes (makes version ' + (m.version + 1) + ')' : 'Save as draft →') + '</button></div>';
  }

  // ---------- MOM page ----------
  function tombstone(m) {
    return '<div class="gone"><div style="font-size:2rem" aria-hidden="true">🗑</div><h2>' + deletedText(m) + '</h2><p class="mut">The notes and points are no longer shown to anyone. Everyone in the MOM sees this same notice.</p></div>' +
      '<div class="card"><h3>Public log</h3><p class="small">👁 ' + esc(nm(m.deleted.by)) + ' deleted this MOM for everyone &middot; ' + fDT(m.deleted.at) + '</p></div>';
  }
  function notFound(msg) { return appShell('<div class="card">' + msg + ' <a href="#/home">Back home</a></div>', 'home'); }
  function viewMom(id, tab) {
    var m = mom(id); if (!m) return notFound('That MOM could not be found.');
    if (m.deleted) return appShell('<p><a href="' + (S.guest ? '#/' : '#/home') + '">← Back</a></p><h1 class="strike">' + esc(m.title) + '</h1>' + tombstone(m), 'home');
    tab = tab || 'points'; var mg = canManage(m), ct = canContribute(m), p = pts(id), pub = m.status === 'published';
    var tabs = [['points', 'Points (' + p.length + ')'], ['details', 'Details'], ['history', 'History v' + m.version], ['chain', 'Chain & logs'], ['files', 'Files (' + m.attachments.length + ')']];
    var h = '<p class="small">' + (S.guest ? '' : '<a href="#/home">← All MOMs</a>') + '</p>' +
      (S.guest ? '<div class="info small">👁 You are reading a shared MOM as <b>' + esc(S.guest) + '</b>. It is read-only. Logs are public to everyone in this MOM.</div>' : '') +
      '<div class="row between"><h1 class="grow" style="margin:0">' + esc(m.title) + '</h1><span class="tag ' + (pub ? 'pub' : 'drf') + '">' + (pub ? '✔ Published' : '✎ Draft') + '</span></div>' +
      '<div class="small mut">' + fD(m.date) + ' &middot; ' + esc(m.venue) + ' &middot; version ' + m.version + '</div>' +
      '<div class="card">' + stepper(momStep(m)) + '</div><div class="row">';
    if (mg) h += '<a class="btn sm ghost" href="#/mom/' + id + '/edit">✎ Update</a>' + (pub ? '' : '<button class="btn sm pl" data-act="publish-ask" data-id="' + id + '">↑ Publish</button>');
    if (ct && pub) h += '<button class="btn sm sf" data-act="share-open" data-id="' + id + '">➤ Share</button>';
    h += '<button class="btn sm ghost" data-act="pdf-open" data-id="' + id + '">📄 PDF</button></div>';
    h += '<div class="tabs" role="tablist">' + tabs.map(function (t) { return '<a role="tab" class="tab' + (t[0] === tab ? ' on' : '') + '" href="#/mom/' + id + (t[0] === 'points' ? '' : '/' + t[0]) + '">' + t[1] + '</a>'; }).join('') + '</div>';
    if (tab === 'points') h += momPoints(m, mg);
    else if (tab === 'details') h += momDetails(m, mg);
    else if (tab === 'history') h += momHistory(m);
    else if (tab === 'chain') h += momChain(m);
    else if (tab === 'files') h += '<div class="card">' + attList(m.attachments) + (ct ? '<button class="btn block ghost" data-act="attach-open" data-o="mom" data-id="' + id + '">＋ Attach text, link, PDF or image</button>' : '') + '</div>';
    return appShell(h, 'home');
  }
  function pointRow(p, showMom) {
    var m = mom(p.momId), late = overdue(p);
    return '<a class="pt ' + ST[p.status].cls + '" href="#/point/' + p.id + '"><div class="t' + (closed(p.status) ? ' strike' : '') + '">' + (showMom ? '' : p.no + '. ') + esc(p.title) + '</div>' +
      '<div class="meta">' + badge(p.status) + avs(p.resp.slice(0, 4)) + '<span>' + esc(p.resp.map(function (e) { return nm(e).split(' ')[0]; }).join(' + ')) + '</span>' + (p.due ? '<span class="' + (late ? 'late' : '') + '">' + (late ? '⚠ Overdue ' : '📅 ') + fD(p.due) + '</span>' : '') + (showMom && m ? '<span>in ' + esc(m.title) + '</span>' : '') + '</div></a>';
  }
  function legend() { return '<div class="small mut" style="margin:6px 0">' + SL.map(function (s) { return badge(s) + ' ' + ST[s].help; }).join('<br>') + '</div>'; }
  function momPoints(m, mg) {
    var all = pts(m.id), list = all.filter(function (p) { return (ui.f === 'all' || p.status === ui.f) && (ui.who === 'all' || p.resp.indexOf(ui.who) > -1); });
    var h = '<div class="scrollx">' + ['all'].concat(SL).map(function (s) { return '<button class="chip hscroll' + (ui.f === s ? ' on' : '') + '" data-act="filter" data-s="' + esc(s) + '">' + (s === 'all' ? 'All' : ST[s].sym + ' ' + s) + '</button>'; }).join('') + '</div>';
    h += '<div class="scrollx"><button class="chip hscroll' + (ui.who === 'all' ? ' on' : '') + '" data-act="who" data-e="all">Everyone</button>' + m.attendees.map(function (e) { return '<button class="chip hscroll' + (ui.who === e ? ' on' : '') + '" data-act="who" data-e="' + esc(e) + '">' + av(e) + ' ' + esc(nm(e).split(' ')[0]) + '</button>'; }).join('') + '</div>';
    h += list.length ? list.map(function (p) { return pointRow(p); }).join('') : '<div class="card c mut">No points here yet. 🌱</div>';
    h += '<details class="card flat"><summary class="small"><b>What do the colours mean?</b></summary>' + legend() + '</details>';
    if (mg) h += '<details class="card" id="addpt"' + (all.length ? '' : ' open') + '><summary><b>＋ Add a point</b></summary><label class="f" for="ap-title">What needs doing?</label><input id="ap-title" type="text" maxlength="200" placeholder="e.g. Call the caterer">' +
      '<label class="f">Who is responsible? (one or more)</label><div id="ap-resp">' + chipsFor(S.users, [S.me]) + '</div>' + (isOwner() ? '<input id="ap-extra" type="text" inputmode="email" placeholder="Or add by e-mail">' : '') +
      '<label class="f" for="ap-status">Status</label><select id="ap-status" class="in">' + SL.map(function (s) { return '<option' + (s === 'WIP' ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<label class="f" for="ap-due">Due date</label><input id="ap-due" type="date" value="' + U.D(7) + '"><label class="f" for="ap-todo">Details (optional)</label><textarea id="ap-todo" maxlength="2000"></textarea><button class="btn block" style="margin-top:10px" data-act="add-point" data-id="' + m.id + '">Add point</button></details>';
    return h;
  }
  function momDetails(m, mg) {
    var h = '<div class="card"><h3>Details</h3><p><b>Date:</b> ' + fD(m.date) + '<br><b>Where:</b> ' + esc(m.venue) + '<br><b>Created by:</b> ' + esc(nm(m.createdBy)) + '</p><h3>Participants (' + m.attendees.length + ')</h3>' +
      m.attendees.map(function (e) { return '<div class="row" style="margin:6px 0">' + av(e, true) + '<div><b>' + esc(nm(e)) + '</b><div class="tiny mut">' + esc(e) + '</div></div></div>'; }).join('') +
      '<h3>Notes</h3><p>' + (esc(m.notes) || '<span class="mut">No notes yet.</span>') + '</p>' + (m.mergedFrom ? '<p class="small" style="color:#5a3ec4">⇄ Created by merging: ' + m.mergedFrom.map(function (i) { return esc(mom(i) ? mom(i).title : 'another MOM'); }).join(' + ') + '</p>' : '') + '</div>';
    if (mg) {
      h += '<div class="danger"><h3>🗑 Removing this MOM</h3>';
      if (m.status === 'published') h += '<p class="small">🔒 A published MOM is kept safe, so it cannot be deleted by a simple tap. Many people rely on it.</p><button class="btn sm rd" disabled>Delete (not available once published)</button><p class="small" style="margin-top:10px">Still need it gone? There is a careful way:</p><button class="btn sm ghost" style="color:#b3261e;border-color:#b3261e" data-act="del-ask" data-id="' + m.id + '">Delete for everyone…</button>';
      else h += '<p class="small">This is still a draft. You can remove it, but everyone will see a notice that it was deleted.</p><button class="btn sm rd" data-act="del-ask" data-id="' + m.id + '">Delete this draft…</button>';
      h += '</div>';
    }
    return h;
  }
  function momHistory(m) {
    var cs = m.events.filter(function (e) { return e.type === 'content'; }).slice().reverse();
    return '<div class="info small">🕒 Nothing is ever lost. Each update becomes a new version, newest first.</div><div class="tl">' + cs.map(function (e) {
      return '<div class="it" style="--dc:' + (e.v === m.version ? '#0e8f6e' : '#6c4bd6') + '"><span class="vtag">v' + e.v + '</span> <b>' + esc(e.what) + '</b>' + (e.v === m.version ? ' <span class="tag pub">Current</span>' : '') +
        '<div class="small mut">' + av(e.by) + ' &nbsp; ' + esc(nm(e.by)) + ' &middot; ' + fDT(e.at) + '</div>' +
        (e.detail ? e.detail.map(function (d) { return '<div class="diff"><b>' + esc(d.f) + '</b><br>' + (d.from ? '<del>' + esc(d.from) + '</del><br>' : '') + '<ins>' + esc(d.to) + '</ins></div>'; }).join('') : '') + '</div>';
    }).join('') + '</div>';
  }
  function momChain(m) {
    var shares = m.events.filter(function (e) { return e.type === 'share'; }), opens = m.events.filter(function (e) { return e.type === 'open'; }), used = {};
    var h = '<h3>🔗 The chain</h3><p class="small mut">Who made or sent a link, and who opened it. A WhatsApp link is only a link until someone opens it: we cannot see whether it was sent.</p>' + sharesList(m);
    if (!shares.length && !opens.length) h += '<div class="card c mut">Not shared yet. Tap Share to start the chain. 🌱</div>';
    shares.forEach(function (s) {
      h += '<div class="ch">' + av(s.by) + ' <b>' + esc(nm(s.by)) + '</b> ' + (s.via === 'whatsapp' ? 'made a 💬 WhatsApp link for' : s.via === 'link' ? 'made a 🔗 link' : 'e-mailed a link to') + (s.via === 'link' ? '' : ' <b>' + esc(String(s.to).replace(' (WhatsApp)', '')) + '</b>') + '<div class="tiny mut">' + fDT(s.at) + '</div></div>';
      var mine = opens.filter(function (x, i) { if (x.shareId === s.shareId) { used[i] = 1; return true; } return false; });
      if (mine.length) mine.forEach(function (o) { h += '<div class="ch op">✅ Opened by <b>' + esc(o.by) + '</b> (e-mail confirmed)<div class="tiny mut">' + fDT(o.at) + '</div></div>'; });
      else h += '<div class="ch no">⏳ Not opened yet</div>';
    });
    opens.forEach(function (o, i) { if (!used[i]) h += '<div class="ch op" style="margin-left:0">✅ <b>' + esc(o.by) + '</b> opened a link from ' + esc(nm(o.from || '')) + '<div class="tiny mut">' + fDT(o.at) + '</div></div>'; });
    h += '<h3 style="margin-top:18px">👁 Public log</h3><div class="info small">Everyone in this MOM can see this log. Openness keeps things fair.</div><div class="card">' +
      m.events.slice().reverse().map(function (e) { return '<div class="small" style="margin:7px 0"><b>' + esc(nm(e.by)) + '</b> &middot; ' + esc(e.what) + '<div class="tiny mut">' + fDT(e.at) + '</div></div>'; }).join('') + '</div>';
    return h;
  }
  // The links of this MOM: when each one stops working, and a Cancel button for whoever may cancel it.
  function sharesList(m) {
    var l = m.shares || []; if (!l.length) return '';
    return '<div class="card flat"><b>Links you can cancel</b>' + l.map(function (x) {
      var state = x.cancelled ? '<span class="tag drf">Cancelled</span>' : x.expired ? '<span class="tag drf">Expired</span>' : '<span class="tag pub">Working</span>';
      return '<div class="row between" style="margin:8px 0"><div class="grow small">' + (x.via === 'email' ? '✉ ' + esc(x.to || '') : x.via === 'whatsapp' ? '💬 ' + esc(x.to || 'WhatsApp') : '🔗 Link') + ' ' + state + '<div class="tiny mut">Made by ' + esc(nm(x.by)) + ' &middot; ' + fDT(x.at) + (x.expiresAt && !x.cancelled ? ' &middot; works until ' + fD(x.expiresAt) : '') + '</div></div>' +
        (x.canCancel && !x.cancelled && !x.expired ? '<button class="btn sm ghost" style="color:#b3261e;border-color:#b3261e" data-act="share-cancel" data-id="' + esc(x.id) + '">Cancel link</button>' : '') + '</div>';
    }).join('') + '</div>';
  }
  function attList(arr) {
    if (!arr.length) return '<p class="mut c">Nothing attached yet. 📎</p>';
    return arr.map(function (a) {
      var u = (a.kind === 'url' || a.kind === 'link') ? safeUrl(a.url || a.name) : a.downloadable ? asq('/api/attachments/' + encodeURIComponent(a.id)) : '';
      var label = u ? '<a href="' + esc(u) + '"' + (a.downloadable ? '' : ' target="_blank" rel="noopener noreferrer"') + '>' + esc(a.name) + '</a>' : esc(a.name);
      return '<div class="row" style="margin:8px 0"><span style="font-size:1.4rem" aria-hidden="true">' + ICON[a.kind] + '</span><div class="grow"><b>' + label + '</b><div class="tiny mut">' + KIND[a.kind] + (a.size ? ' &middot; ' + esc(a.size) : '') + ' &middot; ' + esc(nm(a.by)) + ' &middot; ' + fDT(a.at) + '</div></div></div>';
    }).join('');
  }

  // ---------- point page ----------
  function viewPoint(id) {
    var p = point(id); if (!p) return notFound('Point not found.');
    var m = mom(p.momId); if (!m) return notFound('Point not found.');
    var ed = canWork(p, m), ct = canContribute(m), cal = ui.cache.integ;
    var h = '<p class="small"><a href="#/mom/' + m.id + '">← ' + esc(m.title) + '</a></p><div class="row"><span class="small mut">Point ' + p.no + '</span>' + badge(p.status) + (overdue(p) ? '<span class="late small">⚠ Overdue</span>' : '') + '</div>';
    h += ed ? '<label class="f" for="pt-title">Point</label><input id="pt-title" type="text" maxlength="200" value="' + esc(p.title) + '">' : '<h1 class="' + (closed(p.status) ? 'strike' : '') + '">' + esc(p.title) + '</h1>';
    if (canManage(m) && m.status === 'draft') h += '<div class="row" style="margin:6px 0"><button class="btn sm ghost" style="color:#b3261e;border-color:#b3261e" data-act="pt-del-ask" data-id="' + p.id + '">🗑 Remove this point</button><span class="tiny mut">Possible while the MOM is a draft. After publishing, mark it Discarded instead.</span></div>';
    if (closed(p.status) && ed) h += '<p class="small strike">Preview: ' + esc(p.title) + ' (crossed out because it is ' + p.status.toLowerCase() + ')</p>';
    h += '<h3 style="margin-top:14px">Status</h3><div class="tiles">' + SL.map(function (s) {
      var ok = ed && (p.status === s || U.canMove(p.status, s));
      return '<button class="tile ' + ST[s].cls + (p.status === s ? ' on' : '') + '" ' + (ok ? 'data-act="setstatus" data-id="' + p.id + '" data-s="' + esc(s) + '"' : 'disabled') + ' aria-pressed="' + (p.status === s) + '"><b>' + badge(s) + '</b><span class="g">' + ST[s].help + '</span></button>';
    }).join('') + '</div>';
    if (ed && closed(p.status)) h += '<p class="hint">A ' + p.status + ' point can be re-opened as <b>' + U.NEXT[p.status].join(' or ') + '</b>. This keeps finished work from changing by accident.</p>';
    h += '<h3 style="margin-top:14px">Responsible (' + p.resp.length + ')</h3><div class="card flat">' + (ed ? '<div class="chips">' + uniq(m.attendees.concat(p.resp)).map(function (e) { return '<button class="chip' + (p.resp.indexOf(e) > -1 ? ' on' : '') + '" data-act="toggle-resp" data-id="' + p.id + '" data-e="' + esc(e) + '">' + av(e) + ' ' + esc(nm(e).split(' ')[0]) + '</button>'; }).join('') + '</div><p class="hint">Tap to add or remove people. A point can have more than one.</p>' + (isOwner() ? '<div class="row"><input id="rp-email" type="email" style="flex:1" placeholder="Add another person by e-mail"><button class="btn sm" data-act="add-resp" data-id="' + p.id + '">Add</button></div>' : '<p class="hint">Only the team owner can bring in someone new.</p>')
      : p.resp.map(function (e) { return '<div class="row" style="margin:4px 0">' + av(e) + ' ' + esc(nm(e)) + '</div>'; }).join('')) + '</div>';
    h += '<div class="card"><label class="f" for="pt-due">Due date</label>' + (ed ? '<input id="pt-due" type="date" value="' + esc(p.due) + '">' : '<p>' + (p.due ? fD(p.due) : 'No date set') + '</p>') +
      '<label class="f" for="pt-todo">What to do</label>' + (ed ? '<textarea id="pt-todo" maxlength="2000">' + esc(p.todo) + '</textarea><button class="btn block" style="margin-top:10px" data-act="save-point" data-id="' + p.id + '">Save changes</button>' : '<p>' + esc(p.todo) + '</p>') + '</div>';
    if (S.me && p.due && !closed(p.status) && (p.resp.indexOf(S.me) > -1 || (S.org && S.org.isOwner))) {
      if (cal === undefined) need('integ', '/api/integrations');
      var conn = cal && cal.providers ? cal.providers.filter(function (x) { return x.connected; }) : [];
      h += '<div class="card flat"><b>📅 Calendar</b>' + (conn.length ? conn.map(function (c) { return '<div class="row" style="margin-top:6px"><span class="grow small">' + esc(c.label) + (c.mode === 'mock' ? ' <span class="mock">MOCK</span>' : '') + '</span><button class="btn sm ghost" data-act="cal-add" data-id="' + p.id + '" data-p="' + c.id + '">Add due date</button></div>'; }).join('') : '<p class="small mut">Connect Google or Microsoft to put due dates on your calendar. <a href="#/integrations">Connect</a></p>') + '</div>';
    }
    h += '<h3>Files and links</h3><div class="card">' + attList(p.attachments) + (ct ? '<button class="btn block ghost" data-act="attach-open" data-o="point" data-id="' + p.id + '">＋ Attach text, link, PDF or image</button>' : '') + '</div>';
    h += '<h3>Updates</h3><div class="card">' + (p.updates.length ? p.updates.slice().reverse().map(function (u) { return '<div style="margin:8px 0">' + av(u.by) + ' &nbsp;<b>' + esc(nm(u.by)) + '</b> <span class="tiny mut">' + fDT(u.at) + '</span><div>' + esc(u.text) + '</div></div>'; }).join('') : '<p class="mut">No updates yet.</p>') +
      (ed ? '<textarea id="up-text" maxlength="2000" placeholder="Write a short update"></textarea><button class="btn sm block" style="margin-top:8px" data-act="post-update" data-id="' + p.id + '">Post update</button>' : '') + '</div>';
    h += '<h3>👁 Public log</h3><div class="card">' + p.log.slice().reverse().map(function (e) { return '<div class="small" style="margin:6px 0"><b>' + esc(nm(e.by)) + '</b> &middot; ' + esc(e.what) + '<div class="tiny mut">' + fDT(e.at) + '</div></div>'; }).join('') + '</div>';
    return appShell(h, 'home');
  }

  // ---------- people ----------
  function viewPeople() {
    var owner = S.org && S.org.isOwner;
    var h = '<h1>Your team 👥</h1><p class="mut">Up to ' + CFG.maxUsers + ' people per team. Tap a person to see every point they handle.</p>';
    h += S.users.map(function (u) {
      var mine = S.points.filter(function (p) { return p.resp.indexOf(u.email) > -1; });
      var mgt = owner && u.email !== S.me ? '<div class="row" style="margin-top:6px">' + (u.role === 'Invited' ? '' : '<button class="btn sm ghost" data-act="own-ask" data-e="' + esc(u.email) + '">Make owner</button>') + '<button class="btn sm ghost" style="color:#b3261e;border-color:#b3261e" data-act="rm-ask" data-e="' + esc(u.email) + '" data-inv="' + (u.role === 'Invited' ? '1' : '') + '">' + (u.role === 'Invited' ? 'Cancel invitation' : 'Remove from team') + '</button></div>' : '';
      return '<div class="card mc"><a class="row" style="text-decoration:none;color:inherit" href="#/person/' + encodeURIComponent(u.email) + '">' + av(u.email, true) + '<div class="grow"><b>' + esc(u.name) + (u.email === S.me ? ' (you)' : '') + '</b><div class="tiny mut">' + esc(u.role) + ' &middot; ' + esc(u.email) + (u.verified ? '' : ' &middot; waiting to join') + '</div><div class="row" style="margin-top:4px">' + SL.map(function (s) { var n = mine.filter(function (p) { return p.status === s; }).length; return '<span class="st ' + ST[s].cls + '">' + ST[s].sym + ' ' + n + '</span>'; }).join('') + '</div></div></a>' + mgt + '</div>';
    }).join('');
    if (owner) h += '<div class="card"><h3>Add a teammate (' + S.users.length + ' of ' + CFG.maxUsers + ')</h3><p class="hint">Invited people count towards the ' + CFG.maxUsers + ' places until they join or you cancel the invitation.</p><label class="f" for="am-email">E-mail ID</label><input id="am-email" type="email" placeholder="name@example.com"><label class="f" for="am-name">Name (optional)</label><input id="am-name" type="text" maxlength="80"><button class="btn block" style="margin-top:8px" data-act="add-member">Add to team</button></div>';
    else h += '<p class="small mut c">Only the team owner can add teammates.</p>';
    return appShell(h, 'people');
  }
  function viewPerson(email, q) {
    var u = user(email); if (!u) return appShell('<div class="card">Person not found. <a href="#/people">Back</a></div>', 'people');
    if (q && q.st) ui.pf = q.st; var f = ui.pf || 'all';
    var mine = S.points.filter(function (p) { return p.resp.indexOf(email) > -1 && mom(p.momId) && !mom(p.momId).deleted; });
    var list = mine.filter(function (p) { return f === 'all' || p.status === f; });
    var me = email === S.me;
    var h = '<div class="row">' + av(email, true) + '<div><h1 style="margin:0">' + (me ? 'My points' : esc(u.name)) + '</h1><div class="small mut">' + esc(u.email) + '</div></div></div><p class="mut">' + (me ? 'Everything you handle, across all MOMs, in one calm list.' : 'All the points ' + esc(u.name.split(' ')[0]) + ' is handling, across all MOMs.') + '</p>';
    h += '<div class="scrollx">' + ['all'].concat(SL).map(function (s) { var n = s === 'all' ? mine.length : mine.filter(function (p) { return p.status === s; }).length; return '<button class="chip hscroll' + (f === s ? ' on' : '') + '" data-act="pfilter" data-s="' + esc(s) + '" data-e="' + esc(email) + '">' + (s === 'all' ? 'All' : ST[s].sym + ' ' + s) + ' (' + n + ')</button>'; }).join('') + '</div>';
    h += list.length ? list.map(function (p) { return pointRow(p, true); }).join('') : '<div class="card c mut">Nothing here. Enjoy the calm. ☕</div>';
    return appShell(h, me ? 'mine' : 'people');
  }

  // ---------- merge ----------
  function viewMerge(q) {
    var ids = (q.ids || '').split(',').filter(function (i) { return mom(i) && !mom(i).deleted; });
    if (ids.length < 2) return appShell('<div class="card">Please choose at least two MOMs first. <a href="#/home">Back</a></div>', 'home');
    var ms = ids.map(mom), att = []; ms.forEach(function (m) { m.attendees.forEach(function (e) { if (att.indexOf(e) < 0) att.push(e); }); });
    var n = ms.reduce(function (a, m) { return a + pts(m.id).length; }, 0);
    return appShell('<p class="small"><a href="#/home">← Cancel</a></p><h1>Merge MOMs ⇄</h1>' +
      '<div class="warn"><b>⚠ Please read this first</b><br>This will merge the MOMs into one new MOM. Participants are merged too, and a merged MOM is created. Your original MOMs stay as they are, marked "Merged into".</div>' +
      '<div class="card"><h3>You are merging</h3>' + ms.map(function (m) { return '<div class="row" style="margin:6px 0">• <b class="grow">' + esc(m.title) + '</b><span class="small mut">' + pts(m.id).length + ' points</span></div>'; }).join('') +
      '<h3>Merged participants (' + att.length + ')</h3>' + avs(att) + ' <span class="small mut">' + esc(names(att)) + '</span><h3 style="margin-top:14px">New MOM</h3><p class="small mut">' + n + ' points will be copied in and renumbered, with their files and people. It starts as a draft so you can check it.</p>' +
      '<label class="f" for="mg-title">Name of the merged MOM</label><input id="mg-title" type="text" maxlength="120" value="' + esc('Merged: ' + ms.map(function (m) { return m.title; }).join(' + ').slice(0, 100)) + '">' +
      '<button class="btn sf block" style="margin-top:12px" data-act="merge-ask" data-ids="' + ids.join(',') + '">Review and merge →</button></div>', 'home');
  }

  // ---------- shared link gate ----------
  function viewShared(token) {
    var sh = ui.sh;
    if (sh.token !== token) { ui.sh = sh = { step: 1, email: '', token: token, info: null, dev: '' }; api('GET', '/api/shared/' + encodeURIComponent(token)).then(function (d) { sh.info = d; render(true); }, function (e) { sh.info = { error: e.message }; render(true); }); }
    var from = sh.info && sh.info.from ? sh.info.from.name : '', hint = sh.info && sh.info.forEmail ? sh.info.forEmail : '';
    var h = '<div class="card c"><div style="font-size:2.2rem" aria-hidden="true">🔐</div><h1>A MOM was shared with you</h1><p class="mut">' + (from ? esc(from) + ' thought you would like to see this. ' : '') + 'To keep it safe, please confirm your e-mail ID first.</p>' + (hint ? '<p class="small"><b>This link was sent to ' + esc(hint) + '.</b> It opens only for that address.</p>' : '') + (sh.info && sh.info.expiresAt ? '<p class="tiny mut">This link works until ' + fD(sh.info.expiresAt) + '.</p>' : '') + '</div>';
    if (sh.info && sh.info.error) h += '<div class="warn">' + esc(sh.info.error) + '</div>';
    else if (sh.step === 1) h += '<div class="card"><label class="f" for="sh-email">Your e-mail ID</label><input id="sh-email" type="email" inputmode="email" value="' + esc(sh.email) + '" placeholder="you@example.com"><button class="btn block" style="margin-top:10px" data-act="sh-send">Send me a code ✉</button></div>';
    else h += '<div class="card"><p>Code sent to <b>' + esc(sh.email) + '</b>.</p><label class="f" for="sh-code">6-digit code</label><input id="sh-code" type="text" inputmode="numeric" maxlength="6" placeholder="123456">' + (sh.dev ? '<p class="hint"><span class="mock">DEV</span> Your code is <b>' + esc(sh.dev) + '</b>.</p>' : '') + '<button class="btn block" data-act="sh-verify">Confirm and open →</button></div>';
    h += publicChain(token);
    h += '<p class="c small"><a href="#/">' + esc(CFG.host) + '</a></p>';
    return siteShell(h);
  }
  // Anyone holding a valid link may see who passed it on and who opened it (outside e-mail addresses are masked) - never the MOM.
  function publicChain(token) {
    var d = need('pc:' + token, '/api/shared/' + encodeURIComponent(token) + '/chain');
    if (!d || d.error || !d.chain || !d.chain.length) return '';
    return '<h3>🔗 Who has passed this on</h3><div class="card">' + d.chain.map(function (c) {
      return c.type === 'share'
        ? '<div class="small" style="margin:7px 0"><b>' + esc(c.by) + '</b> ' + (c.via === 'email' ? 'e-mailed a link to ' + esc(c.to || '') : c.via === 'whatsapp' ? 'made a WhatsApp link for ' + esc(c.to || 'a chat') : 'made a link') + '<div class="tiny mut">' + fDT(c.at) + '</div></div>'
        : '<div class="small" style="margin:7px 0">✅ <b>' + esc(c.by) + '</b> opened it' + (c.from ? ' (from ' + esc(c.from) + ')' : '') + '<div class="tiny mut">' + fDT(c.at) + '</div></div>';
    }).join('') + '</div>';
  }

  // ---------- integrations, mailbox, billing ----------
  function viewInteg() {
    var d = need('integ', '/api/integrations'), q = location.hash.indexOf('err=') > -1 ? decodeURIComponent(location.hash.split('err=')[1]) : '';
    var h = '<h1>Connect your tools 🔌</h1>' + (q ? '<div class="warn small">' + esc(q) + '</div>' : '');
    if (!d) return appShell(h + LOADING, '');
    if (d.error) return appShell(h + '<div class="warn">' + esc(d.error) + '</div>', '');
    var mock = d.providers.some(function (p) { return p.mode === 'mock'; });
    h += (mock ? '<div class="warn small"><span class="mock">MOCK</span> Without Google or Microsoft app credentials these buttons only pretend: nothing is read from or written to a real calendar.</div>' : '') + '<p class="mut">Put the due dates of your points on your own calendar. MOM asks for calendar access only.</p>';
    var meta = { google: ['G', '#1a73e8'], microsoft: ['M', '#d83b01'] };
    h += d.providers.map(function (p) {
      return '<div class="card integ"><div class="ic" style="background:' + meta[p.id][1] + '" aria-hidden="true">' + meta[p.id][0] + '</div><div><b>' + esc(p.label) + '</b> ' + (p.connected ? '<span class="tag pub">✔ Connected' + (p.mode === 'mock' ? ' (mock)' : '') + '</span>' : '') + (p.mode === 'mock' ? ' <span class="mock">MOCK</span>' : '') + '<div class="small mut">' + (p.connected ? esc(p.account || '') : 'Add due dates to your calendar.') + '</div>' +
        (p.connected ? '<button class="btn sm ghost" style="margin-top:6px" data-act="disconnect" data-k="' + p.id + '">Disconnect</button>' : '<button class="btn sm" style="margin-top:6px" data-act="connect" data-k="' + p.id + '">Connect</button>') + '</div></div>';
    }).join('');
    return appShell(h, '');
  }
  function viewMail() {
    var h = '<h1>Dev mailbox ✉</h1><p class="mut">Development mode only: every e-mail the app would send is kept here instead. In production this screen does not exist.</p>';
    var d = need('mail', '/api/dev/outbox');
    if (!d) return appShell(h + LOADING, '');
    if (d.error) return appShell(h + '<div class="warn">' + esc(d.error) + '</div>', '');
    h += d.mails.length ? d.mails.map(function (x) { return '<div class="card flat"><b>' + esc(x.subject) + '</b><div class="small mut">To ' + esc(x.to_addr) + ' &middot; ' + fDT(x.at) + ' &middot; ' + esc(x.status) + '</div><pre style="white-space:pre-wrap;font:inherit;font-size:.85rem;margin:6px 0 0">' + esc(x.body) + '</pre></div>'; }).join('') : '<div class="card c mut">No e-mails yet. ✉</div>';
    return appShell(h, '');
  }
  function viewBilling() {
    var d = need('billing', '/api/billing'), o = need('orders', '/api/billing/orders');
    var h = '<h1>Plan and billing 💳</h1>';
    if (!d || !o) return appShell(h + LOADING, '');
    if (d.error) return appShell(h + '<div class="warn">' + esc(d.error) + '</div>', '');
    h += '<div class="card">' + (d.state === 'active' ? '<b>✔ ' + esc(d.planName === 'yearly' ? '12-month plan' : 'Monthly plan') + ' is active</b><div class="small mut">Until ' + fD(d.until) + '. Paying again adds time on top.</div>' : d.state === 'trial' ? '<b>🌱 Free trial</b><div class="small mut">Until ' + fD(d.until) + '. Everything is switched on.</div>' : '<b>⏳ Trial ended</b><div class="small mut">' + (S.org && S.org.enforcePlan ? 'You can read everything. Choose a plan to keep editing.' : 'Editing is still switched on while we are getting started. Choose a plan any time.') + '</div>') + '</div>';
    h += planCards(true);
    if (!d.paymentReady) h += '';
    if (o.orders && o.orders.length) h += '<h3>Payments</h3>' + o.orders.map(function (x) { return '<div class="card flat small">' + U.rs(x.amount_paise) + ' &middot; ' + esc(x.plan) + ' &middot; <b>' + esc(x.status) + '</b> &middot; ' + fD(x.created_at) + (x.status !== 'paid' && x.status !== 'failed' ? '<div class="tiny mut">Paid but no plan yet? Please quote order number ' + esc(x.id) + ' to support.</div>' : '') + (x.status === 'paid' ? '<div class="row" style="margin-top:6px"><button class="btn sm ghost" data-act="receipt" data-o="' + esc(x.id) + '">🧾 Receipt</button>' + (isOwner() ? '<button class="btn sm ghost" data-act="refund-ask" data-o="' + esc(x.id) + '">Ask for a refund</button>' : '') + '</div>' : '') + '</div>'; }).join('');
    return appShell(h, '');
  }

  // ---------- print / pdf ----------
  function viewPrint(id) {
    var m = mom(id); if (!m || m.deleted) return appShell('<div class="card">Not available.</div>', 'home');
    var h = '<div class="noprint row" style="margin-bottom:10px"><a class="btn sm ghost" href="#/mom/' + id + '">← Back</a><button class="btn sm" data-act="print">🖨 Print / Save as PDF</button><button class="btn sm sf" data-act="pdf-dl" data-id="' + id + '">⬇ Download PDF file</button></div>' +
      '<div class="paper"><h1>' + esc(m.title) + '</h1><p>' + fD(m.date) + ' &middot; ' + esc(m.venue) + ' &middot; ' + (m.status === 'published' ? 'Published' : 'Draft') + ', version ' + m.version + '</p><p><b>Participants:</b> ' + esc(names(m.attendees)) + '</p><p><b>Notes:</b> ' + esc(m.notes) + '</p><h2>Points of action</h2><table class="t"><tr><th>#</th><th>Point</th><th>Status</th><th>Responsible</th><th>Due</th></tr>' +
      pts(id).map(function (p) { return '<tr><td>' + p.no + '</td><td class="' + (closed(p.status) ? 'strike' : '') + '">' + esc(p.title) + '</td><td>' + ST[p.status].sym + ' ' + p.status + '</td><td>' + esc(names(p.resp)) + '</td><td>' + fD(p.due) + '</td></tr>'; }).join('') + '</table>' +
      '<h2>History</h2>' + m.events.filter(function (e) { return e.type === 'content'; }).map(function (e) { return '<div class="small">v' + e.v + ' &middot; ' + esc(e.what) + ' &middot; ' + esc(nm(e.by)) + ' &middot; ' + fDT(e.at) + '</div>'; }).join('') + '<p class="tiny mut">Made with MOM, ' + esc(CFG.host) + '</p></div>';
    return appShell(h, 'home');
  }
  function downloadPdf(id) {
    var lossy = false;
    return fetch(asq('/api/moms/' + encodeURIComponent(id) + '/pdf'), { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error((j && j.error && j.error.message) || 'Could not make the PDF.'); });
      lossy = r.headers.get('x-pdf-lossy') === '1';
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a'), m = mom(id);
      a.href = URL.createObjectURL(blob); a.download = ((m && m.title) || 'MOM').replace(/[^\w]+/g, '-') + '.pdf'; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      if (lossy) { modal('<h2>One more step 📄</h2><p>This MOM uses letters (for example Hindi or another script) that the simple PDF file cannot draw, so some of them show as "?" in that file.</p><p>For a perfect copy, open the <b>print view</b> and choose "Save as PDF" there. Your phone or browser draws every script correctly.</p><a class="btn block" href="#/print/' + esc(id) + '">🖨 Open print view</a><button class="btn ghost block" style="margin-top:8px" data-act="close">Close</button>'); }
      else toast('PDF downloaded ✔');
      return refresh(true);
    });
  }

  // ---------- router ----------
  function route() {
    if (!ui.loaded) return '<div class="wrap">' + LOADING + '</div>';
    var raw = location.hash.slice(1) || '/', i = raw.indexOf('?'), path = i < 0 ? raw : raw.slice(0, i), q = {};
    if (i >= 0) raw.slice(i + 1).split('&').forEach(function (kv) { var a = kv.split('='); if (a[0]) q[a[0]] = decodeURIComponent(a[1] || ''); });
    var p = path.split('/').filter(Boolean).map(decodeURIComponent), r = p[0] || 'site';
    var open = { site: 1, pricing: 1, signin: 1, shared: 1 };
    if (!open[r] && !S.me && !S.guest) { location.replace('#/signin'); return ''; }
    if (S.guest && !open[r] && r !== 'mom' && r !== 'point' && r !== 'print') { location.replace('#/mom/' + S.guestMom); return ''; }
    if (S.guest && r === 'mom' && p[1] !== S.guestMom) { location.replace('#/mom/' + S.guestMom); return ''; }
    if (S.guest && p[2] === 'edit') { location.replace('#/mom/' + S.guestMom); return ''; }
    switch (r) {
      case 'site': return viewSite();
      case 'pricing': return viewPricing();
      case 'signin': return viewSignin();
      case 'shared': return viewShared(p[1]);
      case 'home': return viewHome();
      case 'new': return viewNew();
      case 'mom': if (p[2] === 'edit') { var m = mom(p[1]); return m && canManage(m) ? appShell('<p class="small"><a href="#/mom/' + m.id + '">← Cancel</a></p><h1>Update this MOM ✎</h1><div class="info small">Saving creates version ' + (m.version + 1) + '. The earlier version stays in History.</div>' + momForm(m), 'home') : viewMom(p[1]); } return viewMom(p[1], p[2]);
      case 'point': return viewPoint(p[1]);
      case 'people': return viewPeople();
      case 'person': return viewPerson(p[1], q);
      case 'merge': return viewMerge(q);
      case 'integrations': return viewInteg();
      case 'mail': return viewMail();
      case 'billing': return viewBilling();
      case 'print': return viewPrint(p[1]);
      default: return viewSite();
    }
  }
  function render(keep) {
    var y = window.scrollY, html = route(); if (html === '') return;
    $('app').innerHTML = html;
    var key = location.hash.split('?')[0];
    if (keep !== true && key !== ui.lastRoute) window.scrollTo(0, 0); else window.scrollTo(0, y);
    ui.lastRoute = key; document.title = 'MOM';
    var on = document.querySelector('.tabs .tab.on'); if (on && on.scrollIntoView) { try { on.scrollIntoView({ inline: 'center', block: 'nearest' }); window.scrollTo(0, keep === true ? y : 0); } catch (e) { /* old browser */ } }
  }
  window.addEventListener('hashchange', function () { closeModal(); ui.cache = {}; render(); });

  // ---------- actions ----------
  var A = {};
  A['si-send'] = function () {
    var e = val('si-email').toLowerCase(), p = emailProblem(e); if (p) return toast(p);
    ui.si.name = val('si-name'); ui.si.team = val('si-team');
    return api('POST', '/api/auth/start', { email: e, name: ui.si.name, team: ui.si.team }).then(function (d) { ui.si.step = 2; ui.si.email = e; ui.si.dev = d.devCode || ''; render(true); });
  };
  A['si-back'] = function (el, ev) { ev.preventDefault(); ui.si = { step: 1, email: '', name: '', team: '', dev: '' }; render(true); };
  A['si-verify'] = function () {
    return api('POST', '/api/auth/verify', { email: ui.si.email, code: val('si-code') }).then(function (d) {
      ui.si = { step: 1, email: '', name: '', team: '', dev: '' };
      return load().then(function () { toast(d.created ? 'Your team is ready. Welcome 🌼' : 'Welcome back 🌼'); go('#/home'); });
    });
  };
    // Leaving the guest view never signs a real user out; a pure guest also drops the guest cookie.
  A['leave'] = function () {
    setGuest(false);
    return load().then(function () { if (S.me) { ui.cache = {}; return go('#/home'); } return api('POST', '/api/auth/logout').then(function () { S = DEAD; go('#/'); }); });
  };
  A['signout'] = function () { return api('POST', '/api/auth/logout').then(function () { setGuest(false); S = DEAD; ui.cache = {}; closeModal(); go('#/'); }); };
  A['more'] = function () {
    modal('<h2>More</h2><div style="display:grid;gap:8px"><a class="btn ghost" href="#/billing">💳 Plan and billing</a><a class="btn ghost" href="#/integrations">🔌 Connect Google / Microsoft</a>' + (CFG.devMail ? '<a class="btn ghost" href="#/mail">✉ Dev mailbox</a>' : '') + '<a class="btn ghost" href="#/">🌐 Website home (' + esc(CFG.host) + ')</a><a class="btn ghost" href="#/pricing">🏷 Pricing</a><button class="btn ghost" data-act="signout">Sign out (' + esc(S.me) + ')</button><button class="btn" data-act="close">Close</button></div>');
  };
  A['close'] = closeModal;
  A['chip'] = function (el) { el.classList.toggle('on'); };
  A['buy'] = function (el) {
    var plan = el.getAttribute('data-p');
    if (!S.me) { ui.afterLogin = '#/billing'; toast('Please sign in first. Your trial starts free.'); return go('#/signin'); }
    if (payBanner()) { showRecheck(new Error('A payment you made is still being checked. Please check it first, so you are not charged twice.')); return; }
    return api('POST', '/api/billing/checkout', { plan: plan }).then(function (o) {
      if (o.provider === 'mock') {
        modal('<h2>Test payment <span class="mock">MOCK</span></h2><p>' + esc(o.label) + ' &middot; <b>' + U.rs(o.amountPaise) + '</b></p><div class="info small">This is a pretend checkout. No money moves. In the real product you pay ' + esc(o.payee) + ' through its secure payment window.</div><button class="btn block" data-act="mock-pay" data-o="' + esc(o.orderId) + '">Pay (test)</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Not now</button>');
        return;
      }
      return openPayFrame(o);
    });
  };
  A['receipt'] = function (el) {
    return api('GET', '/api/billing/orders/' + encodeURIComponent(el.getAttribute('data-o')) + '/receipt').then(function (r) {
      modal('<h2>Payment receipt 🧾</h2><div class="paper" style="padding:12px"><p><b>' + esc(r.payee) + '</b>' + (r.gstin ? '<br>GSTIN ' + esc(r.gstin) : '') + '</p><p>Receipt no. ' + esc(r.receiptNo) + '<br>Paid on ' + fD(r.paidAt) + '<br>Team: ' + esc(r.teamName) + '</p><p><b>' + esc(r.item) + '</b><br>Amount: <b>' + U.rs(r.amountPaise) + '</b>' + (r.paymentId ? '<br>Payment ref: ' + esc(r.paymentId) : '') + '</p><p class="tiny mut">' + esc(r.note) + '</p></div><button class="btn block" style="margin-top:8px" data-act="print">🖨 Print / Save as PDF</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Close</button>');
    });
  };
  A['refund-ask'] = function (el) {
    modal('<h2>Ask for a refund</h2><p class="small mut">Plans are prepaid. Tell us what went wrong and ' + esc(CFG.payee) + ' will look at it and reply by e-mail. Nothing is refunded automatically.</p><label class="f" for="rf-reason">What happened? (optional)</label><textarea id="rf-reason" maxlength="500"></textarea><button class="btn block" style="margin-top:10px" data-act="refund-do" data-o="' + esc(el.getAttribute('data-o')) + '">Send request</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Not now</button>');
  };
  A['refund-do'] = function (el) {
    return api('POST', '/api/billing/orders/' + encodeURIComponent(el.getAttribute('data-o')) + '/refund-request', { reason: val('rf-reason') }).then(function () { closeModal(); toast('Request sent. We will reply by e-mail.'); });
  };
  A['mock-pay'] = function (el) {
    return api('POST', '/api/billing/mock-pay', { orderId: el.getAttribute('data-o') }).then(function (sig) { return api('POST', '/api/billing/verify', sig); }).then(function () { closeModal(); toast('Payment received. Thank you! 🌼'); return refresh(true); });
  };
  // Payments follow the owner's rule: the payment window runs inside the central payment frame of IT SERVICES BY RAJAT AGARWAL, never on this site.
  // We send the order to the frame (it must be on the frame's allow-list), and it answers 'paid', 'dismissed' or 'failed'. Then the server confirms with the central service.
  var PAID_KEY = 'mom_paid_pending';
  // A payment that was made but not yet confirmed stays on every screen until it is confirmed (this tab only).
  function payBanner() { return payPending && S.me && payPending.email === S.me ? '<div class="info small" role="status">You paid, but we have not been able to confirm it yet. <button class="btn sm" data-act="recheck-pay">Check my payment</button></div>' : ''; }
  function savePaid(p) { p.email = S.me || ''; try { sessionStorage.setItem(PAID_KEY, JSON.stringify(p)); } catch (e) { /* the copy in memory is enough */ } payPending = p; }
  function clearPaid() { try { sessionStorage.removeItem(PAID_KEY); } catch (e) { /* ignore */ } payPending = null; }
  var payPending = null; try { payPending = JSON.parse(sessionStorage.getItem(PAID_KEY) || 'null'); } catch (e) { payPending = null; }
  function confirmPaid(p) {
    return api('POST', '/api/billing/verify', p).then(function () { clearPaid(); closeModal(); toast('Payment received. Thank you! 🌼'); return refresh(true).catch(function () { /* the payment is confirmed; the screen will refresh on the next tap */ }); },
      function (e) { if (e && (e.status === 403 || e.status === 404 || e.code === 'TEST_PAYMENT')) clearPaid(); throw e; }); // another person's or an unknown payment cannot be confirmed here: stop offering it
  }
  // The buyer has paid but the server could not confirm yet (the payment service was busy): keep the details and offer to check again. Verifying is safe to repeat.
  function showRecheck(e) {
    modal('<h2>We are checking your payment</h2><p class="small">' + esc((e && e.message) || 'The payment could not be confirmed yet.') + '</p><button class="btn block" data-act="recheck-pay">Check my payment</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Close</button>');
  }
  A['recheck-pay'] = function () {
    if (!payPending) { closeModal(); return; }
    return confirmPaid(payPending).catch(function (e) { showRecheck(e); });
  };
  function openPayFrame(o) {
    return new Promise(function (resolve, reject) {
      var frameOrigin;
      try { frameOrigin = new URL(o.frameUrl).origin; } catch (e) { return reject(new Error('The payment window is not available yet. Nothing was charged.')); }
      var f = document.createElement('iframe'), cancel = document.createElement('button'), done = false, sent = false, timer;
      f.src = o.frameUrl; f.title = 'Secure payment'; f.setAttribute('allow', 'payment');
      f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483000;background:transparent';
      cancel.type = 'button'; cancel.textContent = 'Cancel'; cancel.setAttribute('aria-label', 'Cancel the payment');
      cancel.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483001;padding:8px 14px;border-radius:8px;border:1px solid #888;background:#fff;color:#1C2B3A;font-size:15px';
      function finish(fn, arg) { if (done) return; done = true; clearTimeout(timer); window.removeEventListener('message', onMsg); if (f.parentNode) f.parentNode.removeChild(f); if (cancel.parentNode) cancel.parentNode.removeChild(cancel); fn(arg); }
      function onMsg(ev) {
        if (ev.source !== f.contentWindow || ev.origin !== frameOrigin || !ev.data || typeof ev.data !== 'object') return;
        var d = ev.data;
        if (d.t === 'ready' && !sent) {
          sent = true;
          f.contentWindow.postMessage({ t: 'open', opts: { key: o.keyId, order_id: o.providerOrderId, amount: o.amountPaise, currency: o.currency, name: 'MOM', description: o.label + ' (' + o.payee + ')', theme: { color: '#1C2B3A' } } }, frameOrigin);
        } else if (d.t === 'paid' && d.resp && typeof d.resp === 'object') {
          var p = { orderId: String(d.resp.razorpay_order_id || ''), paymentId: String(d.resp.razorpay_payment_id || ''), signature: String(d.resp.razorpay_signature || '') };
          finish(function () { savePaid(p); confirmPaid(p).then(resolve, function (e) { showRecheck(e); resolve(); }); });
        } else if (d.t === 'dismissed') { finish(resolve); }
        else if (d.t === 'failed') { finish(reject, new Error(typeof d.message === 'string' ? d.message.slice(0, 200) : 'The payment failed. Nothing was charged.')); }
      }
      cancel.addEventListener('click', function () { if (sent && !window.confirm('A payment may be in progress. Leave anyway?')) return; finish(resolve); });
      window.addEventListener('message', onMsg);
      document.body.appendChild(f); document.body.appendChild(cancel);
      // If the frame never says ready, give up after 20 seconds; the Cancel button is always there.
      timer = setTimeout(function () { if (!sent) finish(reject, new Error('The payment window did not open. Please check your connection and try again.')); }, 20000);
    });
  }
  // MOM create / edit
  A['save-mom'] = function (el) {
    var id = el.getAttribute('data-id'), title = val('mf-title'), att;
    if (!title) return toast('Please give the MOM a title.');
    att = uniq(pickedChips('#mf-att').concat(extraEmails('mf-extra')));
    if (!att.length) return toast('Please pick at least one participant.');
    var b = { title: title, date: val('mf-date'), venue: val('mf-venue'), notes: val('mf-notes'), attendees: att };
    if (!id) return api('POST', '/api/moms', b).then(function (r) { toast('Draft saved. Now add your first point ✔'); return load().then(function () { go('#/mom/' + r.id); }); });
    return api('PATCH', '/api/moms/' + id, b).then(function (r) { if (!r.changed) return toast('Nothing changed yet.'); toast('Saved as version ' + r.version + ' ✔'); return load().then(function () { go('#/mom/' + id + '/history'); }); });
  };
  A['publish-ask'] = function (el) {
    var id = el.getAttribute('data-id'), m = mom(id);
    modal('<h2>Publish this MOM? ↑</h2><p>"' + esc(m.title) + '" will be sent to its ' + m.attendees.length + ' participants by e-mail.</p><div class="warn small">After publishing, the MOM <b>cannot be deleted</b> by a simple tap. You can still update it, and every change stays in History.</div><button class="btn block" data-act="publish-do" data-id="' + id + '">Yes, publish</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Not yet</button>');
  };
  A['publish-do'] = function (el) { return api('POST', '/api/moms/' + el.getAttribute('data-id') + '/publish').then(function () { closeModal(); toast('Published ✔ Next: share it'); return refresh(true); }); };
  // delete
  A['del-ask'] = function (el) {
    var m = mom(el.getAttribute('data-id')), pub = m.status === 'published';
    modal('<h2 style="color:#b3261e">' + (pub ? 'Delete for everyone?' : 'Delete this draft?') + '</h2><div class="danger"><b>This MOM will be deleted for all.</b><br>Every participant will see: "This MOM has been deleted by @' + esc(nm(S.me)) + ' on date at time". The notes and points will no longer be shown.</div>' + (pub ? '<p class="small">This MOM was published, so please be sure. This cannot be undone.</p>' : '') +
      '<label class="cb"><input type="checkbox" id="del-ok"> <span>I understand "' + esc(m.title) + '" will be deleted for all.</span></label><button class="btn rd block" data-act="del-do" data-id="' + m.id + '">Delete for everyone</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Keep it</button>');
  };
  A['del-do'] = function (el) {
    if (!$('del-ok').checked) return toast('Please tick the box to confirm.');
    var m = mom(el.getAttribute('data-id'));
    return api('POST', '/api/moms/' + m.id + '/delete-for-all', { confirm: true }).then(function () { closeModal(); toast('Deleted for everyone'); return load().then(function () { go('#/mom/' + m.id); }); });
  };
  // merge
  A['merge-mode'] = function () { ui.merge = !ui.merge; ui.sel = []; render(true); };
  A['sel'] = function (el) { var id = el.getAttribute('data-id'), i = ui.sel.indexOf(id); if (i > -1) ui.sel.splice(i, 1); else ui.sel.push(id); render(true); };
  A['merge-go'] = function () { go('#/merge?ids=' + ui.sel.join(',')); };
  A['merge-ask'] = function (el) {
    var ids = el.getAttribute('data-ids'), t = val('mg-title') || 'Merged MOM';
    modal('<h2>Merge these MOMs?</h2><div class="warn small">This will merge the MOMs into one new MOM. Participants are merged too, and a merged MOM is created.</div><p>New MOM: <b>' + esc(t) + '</b></p><button class="btn sf block" data-act="merge-do" data-ids="' + ids + '" data-t="' + esc(t) + '">Yes, merge them</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Not now</button>');
  };
  A['merge-do'] = function (el) {
    return api('POST', '/api/moms/merge', { ids: el.getAttribute('data-ids').split(','), title: el.getAttribute('data-t'), confirm: true }).then(function (r) { ui.merge = false; ui.sel = []; closeModal(); toast('Merged MOM created ✔'); return load().then(function () { go('#/mom/' + r.id); }); });
  };
  // points
  A['filter'] = function (el) { ui.f = el.getAttribute('data-s'); render(true); };
  A['who'] = function (el) { ui.who = el.getAttribute('data-e'); render(true); };
  A['pfilter'] = function (el) { ui.pf = el.getAttribute('data-s'); render(true); };
  A['add-point'] = function (el) {
    var t = val('ap-title'), r = uniq(pickedChips('#ap-resp').concat(extraEmails('ap-extra')));
    if (!t) return toast('Please say what needs doing.'); if (!r.length) return toast('Please choose at least one responsible person.');
    return api('POST', '/api/moms/' + el.getAttribute('data-id') + '/points', { title: t, owners: r, due: val('ap-due'), status: val('ap-status'), todo: val('ap-todo') }).then(function () { toast('Point added ✔'); return refresh(true); });
  };
  A['setstatus'] = function (el) {
    var s = el.getAttribute('data-s'), p = point(el.getAttribute('data-id')); if (p.status === s) return;
    return api('POST', '/api/points/' + p.id + '/status', { status: s }).then(function () { toast(s === 'Complete' ? 'Marked Complete. Well done! ✔' : 'Status is now ' + s); return refresh(true); });
  };
  A['toggle-resp'] = function (el) {
    var p = point(el.getAttribute('data-id')), e = el.getAttribute('data-e'), on = p.resp.indexOf(e) > -1;
    if (on && p.resp.length === 1) return toast('A point needs at least one responsible person.');
    return api('POST', '/api/points/' + p.id + '/owners', on ? { remove: [e] } : { add: [e] }).then(function () { return refresh(true); });
  };
  A['add-resp'] = function (el) {
    var e = val('rp-email').toLowerCase(), pr = emailProblem(e); if (pr) return toast(pr);
    return api('POST', '/api/points/' + el.getAttribute('data-id') + '/owners', { add: [e] }).then(function () { toast('Added ✔'); return refresh(true); });
  };
  A['save-point'] = function (el) {
    var t = val('pt-title'); if (!t) return toast('The point needs a title.');
    return api('PATCH', '/api/points/' + el.getAttribute('data-id'), { title: t, due: val('pt-due'), todo: val('pt-todo') }).then(function (r) { toast(r.changed ? 'Saved ✔' : 'Nothing changed yet.'); return refresh(true); });
  };
  A['post-update'] = function (el) {
    var t = val('up-text'); if (!t) return toast('Please write a few words first.');
    return api('POST', '/api/points/' + el.getAttribute('data-id') + '/updates', { text: t }).then(function () { toast('Update posted ✔'); return refresh(true); });
  };
  A['add-member'] = function () {
    var e = val('am-email').toLowerCase(), pr = emailProblem(e); if (pr) return toast(pr);
    return api('POST', '/api/team/members', { email: e, name: val('am-name') }).then(function () { toast('Invitation sent ✔'); return refresh(true); });
  };
  A['rm-ask'] = function (el) {
    var e = el.getAttribute('data-e'), inv = el.getAttribute('data-inv') === '1';
    modal('<h2>' + (inv ? 'Cancel this invitation?' : 'Remove from the team?') + '</h2><p><b>' + esc(nm(e)) + '</b> (' + esc(e) + ')</p><p class="small">' + (inv ? 'They will not be able to join with this invitation.' : 'They lose access at once. Everything they did stays in the history. They can start a team of their own.') + '</p><button class="btn rd block" data-act="rm-do" data-e="' + esc(e) + '">' + (inv ? 'Cancel invitation' : 'Remove') + '</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Keep</button>');
  };
  A['rm-do'] = function (el) { return api('POST', '/api/team/members/remove', { email: el.getAttribute('data-e') }).then(function () { closeModal(); toast('Done ✔'); return refresh(true); }); };
  A['own-ask'] = function (el) {
    var e = el.getAttribute('data-e');
    modal('<h2>Make ' + esc(nm(e)) + ' the team owner?</h2><p class="small">The owner manages the team, the plan and the payments. A team has exactly one owner, so you become a normal member. You will not be able to undo this yourself.</p><button class="btn block" data-act="own-do" data-e="' + esc(e) + '">Yes, hand over ownership</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Not now</button>');
  };
  A['own-do'] = function (el) { return api('POST', '/api/team/owner', { email: el.getAttribute('data-e') }).then(function () { closeModal(); toast('Ownership handed over ✔'); return refresh(true); }); };
  A['pt-del-ask'] = function (el) {
    var p = point(el.getAttribute('data-id'));
    modal('<h2>Remove this point?</h2><p>"' + esc(p.title) + '"</p><p class="small">Later points move up one number. This is possible only while the MOM is a draft.</p><button class="btn rd block" data-act="pt-del-do" data-id="' + p.id + '">Remove point</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Keep it</button>');
  };
  A['pt-del-do'] = function (el) {
    var p = point(el.getAttribute('data-id')), mid = p.momId;
    return api('DELETE', '/api/points/' + encodeURIComponent(p.id)).then(function () { closeModal(); toast('Point removed'); return load().then(function () { go('#/mom/' + mid); }); });
  };
  A['cal-add'] = function (el) {
    return api('POST', '/api/points/' + el.getAttribute('data-id') + '/calendar', { provider: el.getAttribute('data-p') }).then(function (r) { toast(r.already ? 'It is on your calendar already ✔' : r.mode === 'mock' ? 'Added (mock calendar) ✔' : 'Added to your calendar ✔'); });
  };
  // attachments
  function attForm() {
    var k = ui.att.kind, f;
    if (k === 'text') f = '<label class="f" for="at-text">Your note</label><textarea id="at-text" maxlength="2000"></textarea>';
    else if (k === 'url') f = '<label class="f" for="at-url">Web address</label><input id="at-url" type="url" placeholder="https://example.com/page">';
    else if (k === 'link') f = '<label class="f" for="at-label">Name of the link</label><input id="at-label" type="text" maxlength="120" placeholder="e.g. Meeting recording"><label class="f" for="at-url">Link</label><input id="at-url" type="url" placeholder="https://drive.example.com/...">';
    else f = '<label class="f" for="at-file">Choose a ' + (k === 'pdf' ? 'PDF' : 'picture') + '</label><input id="at-file" type="file" accept="' + (k === 'pdf' ? 'application/pdf' : 'image/png,image/jpeg,image/gif,image/webp') + '"><p class="small">Chosen: <b id="att-fname">' + esc(ui.att.file ? ui.att.file.name : 'nothing yet') + '</b></p><p class="hint">Files up to 1 MB.</p>';
    return '<div class="chips" style="margin-bottom:6px">' + Object.keys(KIND).map(function (x) { return '<button class="chip' + (x === k ? ' on' : '') + '" data-act="atype" data-k="' + x + '">' + ICON[x] + ' ' + KIND[x] + '</button>'; }).join('') + '</div>' + f + '<button class="btn block" style="margin-top:12px" data-act="attach-add">Attach</button><button class="btn ghost block" style="margin-top:8px" data-act="close">Cancel</button>';
  }
  A['attach-open'] = function (el) { ui.att = { kind: 'text', o: el.getAttribute('data-o'), id: el.getAttribute('data-id') }; modal('<h2>Attach something 📎</h2><div id="att-body">' + attForm() + '</div>'); };
  A['atype'] = function (el) { ui.att.kind = el.getAttribute('data-k'); ui.att.file = null; $('att-body').innerHTML = attForm(); };
  A['attach-add'] = function () {
    var k = ui.att.kind, b = { kind: k };
    if (k === 'text') { b.text = val('at-text'); if (!b.text) return toast('Please write your note.'); }
    else if (k === 'url') { b.url = val('at-url'); if (!safeUrl(b.url)) return toast('Please type a full web address starting with https://'); }
    else if (k === 'link') { b.url = val('at-url'); b.name = val('at-label'); if (!safeUrl(b.url)) return toast('Please type a full link starting with https://'); }
    else { if (!ui.att.file) return toast('Please choose a file first.'); b.name = ui.att.file.name; b.dataBase64 = ui.att.file.data; }
    var path = (ui.att.o === 'mom' ? '/api/moms/' : '/api/points/') + ui.att.id + '/attachments';
    return api('POST', path, b).then(function () { ui.att.file = null; closeModal(); toast('Attached ✔'); return refresh(true); });
  };
  // share
  function shareBody(m) {
    var t = ui.shareTab, tabs = [['email', '✉ E-mail'], ['whatsapp', '💬 WhatsApp'], ['link', '🔗 Link']];
    var h = '<div class="chips" style="margin-bottom:8px">' + tabs.map(function (x) { return '<button class="chip' + (t === x[0] ? ' on' : '') + '" data-act="shtab" data-t="' + x[0] + '" data-id="' + m.id + '">' + x[1] + '</button>'; }).join('') + '</div>';
    if (t === 'email' && CFG.mail && CFG.mail.ready === false) h += '<div class="warn small">E-mail is not switched on yet, so this cannot be sent right now. A WhatsApp or plain link still works.</div>';
    if (t === 'email') h += '<label class="f" for="sx-email">Send to (e-mail ID)</label><input id="sx-email" type="email" inputmode="email" placeholder="friend@example.com"><button class="btn block" style="margin-top:8px" data-act="share-email" data-id="' + m.id + '">Send by e-mail ✉</button>';
    else if (t === 'whatsapp') h += '<p class="small mut">Opens WhatsApp with a ready message. Pick the chat there. Whoever opens the link confirms their e-mail first.</p><label class="f" for="sx-wa">Who is it for? (just a label for the log)</label><input id="sx-wa" type="text" maxlength="60" placeholder="e.g. Society chat"><button class="btn block" style="margin-top:8px" data-act="share-wa" data-id="' + m.id + '">Open WhatsApp 💬</button>';
    else h += (ui.shareLink ? '<div class="card flat"><b style="word-break:break-all">' + esc(ui.shareLink) + '</b></div><button class="btn sm ghost" data-act="copy-link" data-l="' + esc(ui.shareLink) + '">Copy link</button>' : '<p class="small mut">Creates a private link. Anyone who opens it must confirm their e-mail first.</p>') + '<button class="btn block" style="margin-top:8px" data-act="share-link" data-id="' + m.id + '">' + (ui.shareLink ? 'Make another link' : 'Create a link') + '</button>';
    h += '<div class="guide" style="margin-top:12px">🔐 Whoever opens a link first confirms their e-mail ID' + (t === 'email' ? ' (an e-mailed link opens only for the address it was sent to)' : '') + '. A link works for ' + (CFG.shareDays || 30) + ' days, and you can cancel it any time. Every open is recorded in the chain.</div>';
    h += sharesList(m);
    h += '<a class="btn ghost block" style="margin-top:8px" data-act="close" href="#/mom/' + m.id + '/chain">See the chain</a>';
    return h;
  }
  A['share-open'] = function (el) { ui.shareLink = null; modal('<h2>Share this MOM ➤</h2><div id="sh-body" data-mom="' + esc(el.getAttribute('data-id')) + '">' + shareBody(mom(el.getAttribute('data-id'))) + '</div>'); };
  A['shtab'] = function (el) { ui.shareTab = el.getAttribute('data-t'); $('sh-body').innerHTML = shareBody(mom(el.getAttribute('data-id'))); };
  function reshare(id) { return load().then(function () { var b = $('sh-body'); if (b) b.innerHTML = shareBody(mom(id)); render(true); }); }
  A['share-cancel'] = function (el) {
    var id = el.getAttribute('data-id');
    return api('POST', '/api/shares/' + encodeURIComponent(id) + '/cancel').then(function () { toast('Link cancelled. It no longer opens.'); return load().then(function () { var b = $('sh-body'), mid = b && b.getAttribute('data-mom'); if (b && mid && mom(mid)) b.innerHTML = shareBody(mom(mid)); render(true); }); });
  };
  A['share-email'] = function (el) {
    var id = el.getAttribute('data-id'), e = val('sx-email').toLowerCase(), pr = emailProblem(e); if (pr) return toast(pr);
    return api('POST', '/api/moms/' + id + '/shares', { via: 'email', to: e }).then(function () { toast('E-mail sent ✔'); return reshare(id); });
  };
  A['share-wa'] = function (el) {
    var id = el.getAttribute('data-id'), w = window.open('', '_blank');
    return api('POST', '/api/moms/' + id + '/shares', { via: 'whatsapp', to: val('sx-wa') }).then(function (r) { if (w) { w.opener = null; w.location = r.waUrl; } else window.location = r.waUrl; toast('WhatsApp opened. The link only counts once someone opens it.'); return reshare(id); }, function (e) { if (w) w.close(); throw e; });
  };
  A['share-link'] = function (el) {
    var id = el.getAttribute('data-id');
    return api('POST', '/api/moms/' + id + '/shares', { via: 'link' }).then(function (r) { ui.shareLink = r.link; return reshare(id); });
  };
  A['copy-link'] = function (el) { try { navigator.clipboard.writeText(el.getAttribute('data-l')); } catch (e) { /* ignore */ } toast('Link copied ✔'); };
  A['sh-send'] = function () {
    var e = val('sh-email').toLowerCase(), pr = emailProblem(e); if (pr) return toast(pr);
    return api('POST', '/api/shared/' + encodeURIComponent(ui.sh.token) + '/code', { email: e }).then(function (d) { ui.sh.email = e; ui.sh.step = 2; ui.sh.dev = d.devCode || ''; render(true); });
  };
  A['sh-verify'] = function () {
    return api('POST', '/api/shared/' + encodeURIComponent(ui.sh.token) + '/verify', { email: ui.sh.email, code: val('sh-code') }).then(function (r) {
      ui.sh = { step: 1, email: '', token: '', info: null, dev: '' }; setGuest(true);
      return load().then(function () { toast('Confirmed. Welcome ✔'); go('#/mom/' + r.momId + '/chain'); });
    });
  };
  // pdf
  A['pdf-open'] = function (el) { var id = el.getAttribute('data-id'); modal('<h2>Download as PDF 📄</h2><p class="mut">A tidy copy with points, statuses and history.</p><button class="btn block" data-act="pdf-dl" data-id="' + id + '">⬇ Download PDF file</button><a class="btn ghost block" style="margin-top:8px" href="#/print/' + id + '">🖨 Open print view (Save as PDF)</a><button class="btn ghost block" style="margin-top:8px" data-act="close">Close</button>'); };
  A['pdf-dl'] = function (el) { closeModal(); return downloadPdf(el.getAttribute('data-id')); };
  A['print'] = function () { window.print(); };
  // integrations
  A['connect'] = function (el) {
    return api('POST', '/api/integrations/' + el.getAttribute('data-k') + '/connect').then(function (r) {
      if (r.mode === 'live') { window.location = r.url; return; }
      toast('Connected (mock) ✔'); return refresh(true);
    });
  };
  A['disconnect'] = function (el) { return api('DELETE', '/api/integrations/' + el.getAttribute('data-k')).then(function () { toast('Disconnected'); return refresh(true); }); };

  function fail(e) {
    if (e && e.status === 401 && S.me) { S.me = null; toast('Please sign in again.'); return go('#/signin'); }
    if (e && e.code === 'PLAN_EXPIRED') { return modal('<h2>Your free trial has ended</h2><p>' + esc(e.message) + '</p><a class="btn block" data-act="close" href="#/billing">See plans</a><button class="btn ghost block" style="margin-top:8px" data-act="close">Close</button>'); }
    if (e && e.status === 401 && ui.asGuest) { setGuest(false); toast('This link no longer works.'); return load().then(function () { go(S.me ? '#/home' : '#/'); }); }
    toast((e && e.message) || 'Something went wrong. Please try again.');
  }
  document.addEventListener('click', function (ev) {
    var el = ev.target.closest ? ev.target.closest('[data-act]') : null;
    if (!el) { if (ev.target.id === 'modal') closeModal(); return; }
    if (el.tagName === 'SELECT' || el.disabled) return;
    var f = A[el.getAttribute('data-act')]; if (!f) return;
    if (ui.busy) return;
    var res;
    try { res = f(el, ev); } catch (e) { return fail(e); }
    if (res && res.then) { ui.busy = true; el.classList.add('wait'); res.then(function () { ui.busy = false; el.classList.remove('wait'); }, function (e) { ui.busy = false; el.classList.remove('wait'); fail(e); }); }
  });
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    if (t.id === 'at-file' && t.files && t.files[0]) {
      var file = t.files[0];
      if (file.size > MAX_FILE) { t.value = ''; return toast('Please keep files under 1 MB.'); }
      var rd = new FileReader();
      rd.onload = function () { var s = String(rd.result), i = s.indexOf(','); ui.att.file = { name: file.name, size: file.size, data: s.slice(i + 1) }; var n = $('att-fname'); if (n) n.textContent = file.name; };
      rd.onerror = function () { toast('That file could not be read.'); };
      rd.readAsDataURL(file);
    }
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeModal();
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.getAttribute && ev.target.getAttribute('data-act') === 'sel') { ev.preventDefault(); A.sel(ev.target); }
    if (ev.key === 'Enter' && ev.target.tagName === 'INPUT') {
      var m = { 'si-email': 'si-send', 'si-code': 'si-verify', 'sh-email': 'sh-send', 'sh-code': 'sh-verify' }[ev.target.id];
      if (m) { ev.preventDefault(); var b = document.querySelector('[data-act="' + m + '"]'); if (b) b.click(); }
    }
  });

  // ---------- start ----------
  render();
  api('GET', '/api/config').then(function (c) { CFG = c; }, function () { /* keep defaults */ }).then(load).then(function () {
    if (ui.afterLogin && S.me) { var h = ui.afterLogin; ui.afterLogin = null; location.hash = h; }
    render();
  }, function () { ui.loaded = true; render(); toast('Could not reach the server. Please check your connection.'); });
})();
