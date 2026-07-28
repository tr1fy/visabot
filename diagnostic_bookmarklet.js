// VFS-Bot-v2 diagnostic bookmarklet -- NOT part of the production bot.
//
// Purpose: passively log every network request the VFS page makes (ours and
// the site's own), so we can see whether the site's frontend ever calls some
// kind of session/token-refresh endpoint on its own -- without babysitting the
// Web Inspector for 40+ minutes.
//
// Patches window.fetch and XMLHttpRequest to record {time, method, url} for
// every request, deduped by (method + url without query string), and posts a
// summary every 5 minutes. Run this ALONE (not alongside the production
// bookmarklet) on a tab you do not otherwise need, let it sit for at least 45
// minutes, then read the Telegram messages.
//
// Like the production bookmarklet, this carries NO bot token: it reports
// through the relay using a per-user key. See the security note in
// bookmarklet.js and RELAY.md.
//
// Worth knowing before you spend 45 minutes on this: the JWT in sessionStorage
// states its own lifetime. decodeJwtPayload()/readSession() in bookmarklet.js
// read `exp` and `iat` directly, which answers "how long does a session last"
// in one second instead of an afternoon. Reach for this diagnostic when you
// need to know what the page *does* over time, not just when it expires.

(function () {
  var RELAY_URL = '__RELAY_URL__';
  var TG_CHAT = '__CHAT_ID__';
  var USER_KEY = '__USER_KEY__';
  var REPORT_MS = 5 * 60 * 1000;

  var seen = {};
  var newSinceLastReport = [];

  function record(method, url) {
    try {
      var s = String(url);
      // Skip our own reporting calls so the log is not mostly noise about
      // itself. Note there is no longer a filter for Telegram's API: this
      // script does not call it any more, so a request to it would be a
      // genuine finding about the page and must not be hidden.
      if (s.indexOf(RELAY_URL) === 0) return;
      var key = method + ' ' + s.split('?')[0];
      if (seen[key]) return;
      seen[key] = true;
      var line = new Date().toLocaleTimeString() + '  ' + key;
      newSinceLastReport.push(line);
      console.log('VFS-DIAG: ' + line);
    } catch (e) {}
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    var method = (init && init.method) || 'GET';
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    record(method, url);
    return origFetch.apply(this, arguments);
  };

  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    record(method, url);
    return origOpen.apply(this, arguments);
  };

  function notify(text) {
    // origFetch, not the patched window.fetch: reporting must not appear in
    // the very log it is reporting.
    origFetch(RELAY_URL + '/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: TG_CHAT, key: USER_KEY, text: text, silent: true })
    }).catch(function (e) {
      console.log('VFS-DIAG: notify failed', e);
    });
  }

  function sessionLine() {
    try {
      var jwt = sessionStorage.getItem('JWT');
      if (!jwt) return 'JWT: нет (вы не вошли в аккаунт на этой вкладке)';
      var parts = String(jwt).split('.');
      if (parts.length < 2) return 'JWT: не разбирается';
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var payload = JSON.parse(atob(b64));
      if (!payload.exp) return 'JWT: без exp';
      var exp = new Date(payload.exp * 1000);
      var lifetime = payload.iat
        ? Math.round((payload.exp - payload.iat) / 60) + ' мин'
        : 'неизвестно';
      return 'JWT истекает ' + exp.toLocaleTimeString() + ' (полный срок: ' + lifetime + ')';
    } catch (e) {
      return 'JWT: ошибка разбора';
    }
  }

  function report() {
    if (newSinceLastReport.length === 0) {
      notify('VFS-DIAG: новых запросов не было (' + new Date().toLocaleTimeString() + ')\n' + sessionLine());
      return;
    }
    notify('VFS-DIAG новые запросы:\n' + newSinceLastReport.join('\n') + '\n\n' + sessionLine());
    newSinceLastReport = [];
  }

  if (window.__vfsDiagRunning) {
    alert('VFS-DIAG уже запущен на этой вкладке.');
    return;
  }
  if (RELAY_URL.indexOf('__') === 0 || USER_KEY.indexOf('__') === 0) {
    alert('VFS-DIAG: закладка не сгенерирована до конца — подставьте relay URL и ключ.');
    return;
  }
  window.__vfsDiagRunning = true;
  notify('VFS-DIAG запущен. Логирую все сетевые запросы, отчёт каждые 5 минут.\n' + sessionLine());
  window.__vfsDiagInterval = setInterval(report, REPORT_MS);
  alert('VFS-DIAG запущен -- логирую сетевые запросы, отчёты в Telegram каждые 5 минут. Оставьте вкладку открытой минимум на 45 минут.');
})();
