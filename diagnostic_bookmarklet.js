// VFS-Bot-v2 diagnostic bookmarklet -- NOT part of the production bot.
//
// Purpose: passively log every network request the VFS page makes (ours
// and the site's own), so we can see whether the site's own frontend ever
// calls some kind of session/token-refresh endpoint on its own -- without
// needing to babysit Safari's Web Inspector for 40+ minutes.
//
// Patches window.fetch and XMLHttpRequest to record {time, method, url}
// for every request, deduped by (method + url without query string), and
// posts a summary to Telegram every 5 minutes. Run this ALONE (not
// alongside the production bookmarklet) on a tab you don't otherwise need,
// let it sit for at least 45 minutes (past the point where sessions have
// been observed to expire), then check the Telegram messages.

(function () {
  var TG_TOKEN = '__BOT_TOKEN__';
  var TG_CHAT = '__CHAT_ID__';
  var REPORT_MS = 5 * 60 * 1000;

  var seen = {};
  var newSinceLastReport = [];

  function record(method, url) {
    try {
      if (String(url).indexOf('api.telegram.org') !== -1) return; // don't log our own instrumentation calls (leaks the bot token into its own report otherwise)
      var key = method + ' ' + url.split('?')[0];
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
    fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: text })
    }).catch(function (e) {
      console.log('VFS-DIAG: notify failed', e);
    });
  }

  function report() {
    if (newSinceLastReport.length === 0) {
      notify('VFS-DIAG: новых запросов не было (' + new Date().toLocaleTimeString() + ')');
      return;
    }
    notify('VFS-DIAG новые запросы:\n' + newSinceLastReport.join('\n'));
    newSinceLastReport = [];
  }

  if (window.__vfsDiagRunning) {
    alert('VFS-DIAG уже запущен на этой вкладке.');
    return;
  }
  window.__vfsDiagRunning = true;
  notify('VFS-DIAG запущен. Логирую все сетевые запросы, отчёт каждые 5 минут.');
  window.__vfsDiagInterval = setInterval(report, REPORT_MS);
  alert('VFS-DIAG запущен -- логирую сетевые запросы, отчёты в Telegram каждые 5 минут. Оставьте вкладку открытой минимум на 45 минут.');
})();
