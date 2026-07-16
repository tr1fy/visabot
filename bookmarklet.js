// VFS-Bot-v2 bookmarklet (readable source)
//
// Install: minify this into a single `javascript:(function(){...})();` URL
// and save it as a Safari bookmark. Click that bookmark while on any
// visa.vfsglobal.com page you're logged into.
//
// What it does: reads the JWT already sitting in sessionStorage (no login
// automation, no Cloudflare interaction -- this is just JS running inside
// your own authenticated tab), polls VFS's internal slot-check API on an
// interval, and pings Telegram every check with the current earliest-slot
// date.
//
// Multi-user design: TG_TOKEN is one shared bot for everyone. TG_CHAT is
// baked into this file at generation time (see generate_bookmarklet.py) --
// each user gets their own unique bookmarklet URL with their own chat ID
// already embedded. Deliberately NOT resolved via prompt()+localStorage:
// that approach silently reuses whatever chat ID was cached the first time
// a given browser was used, which breaks the moment someone switches
// Telegram accounts in the same browser and re-fires the same bookmark.
// A unique URL per user has no such ambiguity.
//
// Command polling deliberately never sends `offset` to Telegram's
// getUpdates -- that parameter permanently acknowledges updates *for the
// whole bot*, not just the caller, so if multiple users' tabs are polling
// concurrently and one of them confirms an offset, everyone else's
// commands could be silently dropped before their own tab ever sees them.
// Instead each browser tracks (in its own localStorage) the highest
// update_id it has already handled *from its own chat* and ignores
// anything at or below that -- duplicate-safe locally, and harmless to
// other users since nothing is ever consumed server-side.
//
// Confirmed live (2026-07-11/12):
// - POST .../appointment/CheckIsSlotAvailable with just `authorize` (=
//   sessionStorage.JWT) + credentials:'include' cookies + a `route` header
//   returns 200 with real slot-date data -- no `clientSource` needed.
// - Time-of-day slot data (via .../appointment/timeslot) was tried and
//   dropped: that endpoint requires a `clientSource` header that VFS's app
//   generates dynamically per request (likely RSA-encrypted client-side)
//   and rotates constantly -- a captured value goes stale within a short
//   window and can't be reliably reused for periodic background checks.
//   Date-only is the stable, supported mode.

(function () {
  var TG_TOKEN = '__BOT_TOKEN__'; // replaced at generation time from config.ini, never committed as a literal
  var TG_CHAT = '__CHAT_ID__'; // replaced per user by generate_bookmarklet.py
  var LAST_UPDATE_KEY = 'vfsbot_last_update_id_' + TG_CHAT; // namespaced in case >1 generated bookmarklet is ever tested in the same browser
  var INTERVAL_MS = 20 * 60 * 1000; // 20 минут -- сохраняем человеческий темп проверок
  var COMMAND_POLL_MS = 4000; // как часто спрашиваем Telegram про новые команды
  var ACTIVITY_MS = 3 * 60 * 1000; // как часто имитируем активность, чтобы сайт не разлогинил по бездействию
  var ROUTE = 'kaz/ru/ita';
  var BODY = {
    countryCode: 'kaz',
    missionCode: 'ita',
    vacCode: 'ALM',
    centerCode: 'ALM',
    visaCategoryCode: 'EAV',
    roleName: 'Individual',
    payCode: ''
  };

  var state = {
    active: true,
    scanRequested: false,
    lastCheckText: null,
    lastCheckTime: null
  };
  var lastUpdateId = parseInt(localStorage.getItem(LAST_UPDATE_KEY), 10);
  if (isNaN(lastUpdateId)) lastUpdateId = null; // null until bootstrapped below, so we never replay history

  function notify(text) {
    fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: text })
    }).catch(function (e) {
      console.log('VFS-Bot: не удалось отправить в Telegram', e);
    });
  }

  function simulateActivity() {
    // VFS's own frontend watches for mouse/keyboard/scroll events to reset
    // its "session timed out due to inactivity" idle timer -- a tab that
    // only does background fetch() calls never triggers those listeners,
    // so the page-level session gets killed even though our API calls are
    // still succeeding. Dispatching harmless synthetic events keeps that
    // idle timer from firing without actually touching any page content.
    try {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 1, clientY: 1 }));
      document.dispatchEvent(new Event('scroll', { bubbles: true }));
      window.dispatchEvent(new Event('focus'));
    } catch (e) {
      console.log('VFS-Bot: не удалось имитировать активность', e);
    }
  }

  function setMyCommands() {
    fetch('https://api.telegram.org/bot' + TG_TOKEN + '/setMyCommands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        commands: [
          { command: 'start', description: 'Resume scanning' },
          { command: 'stop', description: 'Pause scanning (bot keeps listening for commands)' },
          { command: 'scan', description: 'Run a scan immediately' },
          { command: 'status', description: 'Show whether the bot is active and the last check result' }
        ]
      })
    }).catch(function (e) {
      console.log('VFS-Bot: не удалось зарегистрировать команды', e);
    });
  }

  function formatStatus() {
    var lines = ['Status: ' + (state.active ? '🟢 active' : '🔴 stopped')];
    if (state.lastCheckTime) {
      lines.push('Last check: ' + state.lastCheckTime.toLocaleString());
      lines.push('Last result: ' + state.lastCheckText);
    } else {
      lines.push('No checks run yet');
    }
    return lines.join('\n');
  }

  function handleCommand(text) {
    // In groups Telegram may suffix commands with the bot's @username
    // (e.g. "/status@vfsreg_bot") to disambiguate between multiple bots --
    // strip that before matching, or every command silently gets ignored
    // in group chats.
    var command = (text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    if (command === '/start') {
      state.active = true;
      return '✅ Bot started. Scanning resumed.';
    }
    if (command === '/stop') {
      state.active = false;
      return '⏸️ Bot stopped. Scanning paused (still listening for commands).';
    }
    if (command === '/scan') {
      state.scanRequested = true;
      check();
      return '🔍 Manual scan queued, will run shortly.';
    }
    if (command === '/status') {
      return formatStatus();
    }
    return null;
  }

  function pollCommands() {
    // Deliberately no `offset` param -- see the comment at the top of this
    // file. We ask for the full unconfirmed backlog every time and filter
    // locally, so we never steal another user's commands off the queue.
    fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?timeout=0')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.result) return;

        if (lastUpdateId === null) {
          // First poll ever on this browser: don't replay old commands
          // (possibly from other users, or from before this tab existed),
          // just establish a starting point.
          var maxSeen = 0;
          data.result.forEach(function (u) {
            if (u.update_id > maxSeen) maxSeen = u.update_id;
          });
          lastUpdateId = maxSeen;
          localStorage.setItem(LAST_UPDATE_KEY, String(lastUpdateId));
          return;
        }

        data.result.forEach(function (update) {
          if (update.update_id <= lastUpdateId) return;
          var message = update.message || update.channel_post;
          if (message) {
            var chatId = String(message.chat && message.chat.id);
            if (chatId === TG_CHAT) {
              lastUpdateId = update.update_id;
              localStorage.setItem(LAST_UPDATE_KEY, String(lastUpdateId));
              var reply = handleCommand(message.text);
              if (reply) notify(reply);
            }
          }
        });
      })
      .catch(function (e) {
        console.log('VFS-Bot: ошибка опроса команд', e);
      });
  }

  function check() {
    if (!state.active && !state.scanRequested) return;
    state.scanRequested = false;
    var jwt = sessionStorage.getItem('JWT');
    var email = sessionStorage.getItem('logged_email');
    if (!jwt) {
      console.log('VFS-Bot: в sessionStorage нет JWT -- вы вошли в аккаунт на этой вкладке?');
      return;
    }

    var body = Object.assign({}, BODY, { loginUser: email });

    fetch('https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        authorize: jwt,
        route: ROUTE
      },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) {
          console.log('VFS-Bot: сессия истекла (статус ' + r.status + '). Войдите заново и снова нажмите закладку.');
          notify('VFS-Bot: сессия истекла. Пожалуйста, войдите заново и снова нажмите на закладку.');
          clearInterval(window.__vfsBotInterval);
          clearInterval(window.__vfsBotActivityInterval);
          window.__vfsBotRunning = false;
          return null;
        }
        return r.text();
      })
      .then(function (t) {
        if (t == null) return;
        console.log('VFS-Bot проверка ' + new Date().toLocaleTimeString() + ': ' + t);
        state.lastCheckTime = new Date();
        var data;
        try {
          data = JSON.parse(t);
        } catch (e) {
          console.log('VFS-Bot: ответ не в формате JSON, пропускаем', e);
          state.lastCheckText = 'error - invalid server response';
          notify('VFS-Bot: ошибка проверки (некорректный ответ сервера).');
          return;
        }
        if (data && data.earliestDate) {
          state.lastCheckText = 'slot found - ' + data.earliestDate;
          notify('VFS: ближайший доступный слот - ' + data.earliestDate);
        } else if (data && data.error) {
          state.lastCheckText = 'error - ' + data.error;
          notify('VFS-Bot: сервер вернул ошибку: ' + data.error);
        } else {
          state.lastCheckText = 'no slots available';
          notify('VFS-Bot: свободных слотов пока нет (проверено ' + state.lastCheckTime.toLocaleString() + ')');
        }
      })
      .catch(function (e) {
        console.log('VFS-Bot: проверка не удалась', e);
        state.lastCheckTime = new Date();
        state.lastCheckText = 'error - network failure';
        notify('VFS-Bot: проверка не удалась (проблема сети).');
      });
  }

  if (window.__vfsBotRunning) {
    alert('VFS-Bot уже запущен на этой вкладке.');
    return;
  }
  window.__vfsBotRunning = true;
  setMyCommands();
  check();
  simulateActivity();
  window.__vfsBotInterval = setInterval(check, INTERVAL_MS);
  window.__vfsBotCommandInterval = setInterval(pollCommands, COMMAND_POLL_MS);
  window.__vfsBotActivityInterval = setInterval(simulateActivity, ACTIVITY_MS);
  notify('VFS-Bot запущен. Команды: /start /stop /scan /status. Проверка каждые 20 минут.');
  alert('VFS-Bot запущен -- проверка каждые 20 минут, команды /start /stop /scan /status доступны в Telegram. Не закрывайте и не перезагружайте эту вкладку (в фоне работать может).');
})();
