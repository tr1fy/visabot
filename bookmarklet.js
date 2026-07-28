// VFS-Bot-v2 bookmarklet (readable source)
//
// Install: minify this into a single `javascript:(function(){...})();` URL and
// save it as a browser bookmark. Click that bookmark while on any
// visa.vfsglobal.com page you are already logged into.
//
// What it does: reads the JWT the site itself put in sessionStorage after your
// manual login, polls VFS's slot-check API on a 20-minute interval, and reports
// to Telegram. No login automation, no captcha interaction, no Cloudflare
// interaction -- this is just JS running inside your own authenticated tab.
//
// ---------------------------------------------------------------------------
// Security model (changed 2026-07-28 -- read this before touching the relay)
// ---------------------------------------------------------------------------
// This file no longer contains the Telegram bot token. It used to, and that was
// a real leak: build_guide.js baked the live token into public/index.html,
// which Vercel serves publicly, so the token was published on the internet.
// Anyone who opened the guide page could take it, read every user's chat via
// getUpdates, and send messages as the bot.
//
// Now the token lives only in the relay's server environment. This file carries
// __USER_KEY__ -- an HMAC of this user's chat id -- which can do exactly two
// things: send a message to that one chat, and read commands from that one
// chat. It is useless for anything else.
//
// IMPORTANT: the previously published bot token must be revoked and reissued
// via @BotFather. Deploying this file does not un-publish a token that has
// already been public.
//
// ---------------------------------------------------------------------------
// Why there is no simulateActivity() any more
// ---------------------------------------------------------------------------
// The old version dispatched synthetic mousemove/scroll/focus events every 3
// minutes, hoping to reset a server-side idle timeout. That cannot work by
// construction: synthetic events never leave the browser, so they cannot reset
// a timer that lives on VFS's servers. Field results in the spec agree -- the
// session died anyway. Worse, synthetic events carry isTrusted:false, which is
// a well-known automation signal, so the code was plausibly doing harm. It has
// been removed and replaced with something that actually answers the question:
// decoding the JWT's own `exp` claim, so we know when the session ends instead
// of guessing (see readSession()).
//
// ---------------------------------------------------------------------------
// Time-of-day slots (spec stage 2)
// ---------------------------------------------------------------------------
// .../appointment/timeslot requires a `clientSource` header that VFS's frontend
// generates and signs per request. We do NOT lift that generator out of the
// page to sign our own requests -- that is defeating an anti-automation control
// and it breaks on every frontend deploy.
//
// Instead: captureTimeslots() passively watches the requests THE PAGE ITSELF
// makes. When you open the time picker on the site by hand, the page signs its
// own request and we simply read the answer off the wire. Times captured that
// way are attached to the next notification. Fully automatic times would need
// the bot to drive the site's UI, which a bookmarklet cannot do reliably from
// an arbitrary page -- see the browser-driven variant for that.

(function () {
  var RELAY_URL = '__RELAY_URL__'; // e.g. https://visabot-nine.vercel.app
  var TG_CHAT = '__CHAT_ID__'; // this user's numeric Telegram chat id
  var USER_KEY = '__USER_KEY__'; // HMAC of TG_CHAT, minted by the relay

  var CURSOR_KEY = 'vfsbot_cursor_' + TG_CHAT;
  var INTERVAL_MS = 20 * 60 * 1000; // unchanged -- spec forbids raising VFS request frequency
  var COMMAND_POLL_MS = 6000; // hits our own relay, not Telegram
  var EXPIRY_WARN_MS = 3 * 60 * 1000; // warn this long before the JWT expires
  var TIMESLOT_FRESH_MS = 30 * 60 * 1000;

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
    expired: false,
    lastCheckText: null,
    lastCheckTime: null,
    lastRawSample: null, // kept for /status when a response shape is unrecognised
    session: null, // { issuedAt, expiresAt } decoded from the JWT
    times: null, // { date, times: [...], capturedAt } from captureTimeslots()
    unknownShapeCount: 0
  };

  var cursor = parseInt(localStorage.getItem(CURSOR_KEY), 10);
  if (isNaN(cursor)) cursor = null;

  // ---------------------------------------------------------------- relay ---

  function notify(text, silent) {
    return fetch(RELAY_URL + '/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: TG_CHAT, key: USER_KEY, text: text, silent: !!silent })
    }).catch(function (e) {
      console.log('VFS-Bot: не удалось отправить в Telegram', e);
    });
  }

  function pollCommands() {
    var url =
      RELAY_URL +
      '/api/commands?chatId=' +
      encodeURIComponent(TG_CHAT) +
      '&key=' +
      encodeURIComponent(USER_KEY) +
      (cursor === null ? '' : '&after=' + cursor);

    fetch(url)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || typeof data.cursor !== 'number') return;
        cursor = data.cursor;
        localStorage.setItem(CURSOR_KEY, String(cursor));
        // On the very first poll the relay returns no commands, only a cursor,
        // so a freshly opened tab never replays yesterday's /stop.
        (data.commands || []).forEach(function (cmd) {
          var reply = handleCommand(cmd.text);
          if (reply) notify(reply);
        });
      })
      .catch(function (e) {
        console.log('VFS-Bot: ошибка опроса команд', e);
      });
  }

  // -------------------------------------------------------------- session ---

  function decodeJwtPayload(jwt) {
    try {
      var parts = String(jwt).split('.');
      if (parts.length < 2) return null;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var raw = atob(b64);
      try {
        return JSON.parse(decodeURIComponent(escape(raw)));
      } catch (inner) {
        return JSON.parse(raw);
      }
    } catch (e) {
      return null;
    }
  }

  // Answers the spec's open question (section 3) directly: the token states its
  // own lifetime, so there is nothing to guess. The 21-44 minute spread the
  // spec observed is what you get when a fixed-length token is read at varying
  // delays after login -- the clock starts at login, not at the bookmarklet click.
  function readSession(jwt) {
    var payload = decodeJwtPayload(jwt);
    if (!payload || !payload.exp) return null;
    return {
      issuedAt: payload.iat ? new Date(payload.iat * 1000) : null,
      expiresAt: new Date(payload.exp * 1000)
    };
  }

  function describeSession() {
    if (!state.session) return 'срок действия сессии неизвестен (в токене нет exp)';
    var msLeft = state.session.expiresAt.getTime() - Date.now();
    var minLeft = Math.round(msLeft / 60000);
    var lifetime =
      state.session.issuedAt
        ? Math.round((state.session.expiresAt - state.session.issuedAt) / 60000) + ' мин'
        : 'неизвестно';
    return (
      'Сессия истекает в ' + state.session.expiresAt.toLocaleTimeString() +
      ' (осталось ' + minLeft + ' мин, полный срок токена: ' + lifetime + ')'
    );
  }

  function expireNow(reason) {
    if (state.expired) return;
    state.expired = true;
    state.active = false;
    state.lastCheckTime = new Date();
    state.lastCheckText = 'session expired (' + reason + ')';
    clearInterval(window.__vfsBotInterval);
    clearTimeout(window.__vfsBotExpiryTimer);
    clearTimeout(window.__vfsBotWarnTimer);
    notify(
      '⛔ Сессия VFS истекла (' + reason + ').\n\n' +
        'Что делать: обновите страницу, войдите в аккаунт заново и нажмите закладку ещё раз. ' +
        'Проверки возобновятся автоматически.\n\n' +
        'Команда /start сессию не воскрешает — нужен именно повторный вход.'
    );
  }

  function scheduleExpiry() {
    clearTimeout(window.__vfsBotExpiryTimer);
    clearTimeout(window.__vfsBotWarnTimer);
    if (!state.session) return;
    var msLeft = state.session.expiresAt.getTime() - Date.now();
    if (msLeft <= 0) return;
    if (msLeft > EXPIRY_WARN_MS) {
      window.__vfsBotWarnTimer = setTimeout(function () {
        notify('⚠️ Сессия VFS истекает через ~3 минуты. Скоро понадобится повторный вход.');
      }, msLeft - EXPIRY_WARN_MS);
    }
    window.__vfsBotExpiryTimer = setTimeout(function () {
      expireNow('истёк срок токена');
    }, msLeft);
  }

  // ------------------------------------------------------- timeslot capture ---

  function extractTimes(node, out, depth) {
    if (!node || depth > 6 || out.length > 60) return out;
    if (typeof node === 'string') {
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(node.trim())) out.push(node.trim());
      return out;
    }
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) extractTimes(node[i], out, depth + 1);
      return out;
    }
    if (typeof node === 'object') {
      for (var k in node) {
        if (Object.prototype.hasOwnProperty.call(node, k)) extractTimes(node[k], out, depth + 1);
      }
    }
    return out;
  }

  function recordTimeslots(bodyText) {
    try {
      var data = JSON.parse(bodyText);
      var times = [];
      extractTimes(data, times, 0);
      if (!times.length) return;
      var unique = times.filter(function (t, i) { return times.indexOf(t) === i; }).sort();
      state.times = { times: unique, capturedAt: new Date() };
      console.log('VFS-Bot: перехвачены времена слотов', unique);
    } catch (e) {
      /* not JSON -- ignore */
    }
  }

  // Passive only: we never issue a timeslot request ourselves, we just read the
  // answer to a request the page made on its own.
  function captureTimeslots() {
    if (window.__vfsBotHooked) return;
    window.__vfsBotHooked = true;

    var isTimeslot = function (url) { return /appointment\/timeslot/i.test(String(url)); };

    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var promise = origFetch.apply(this, arguments);
      if (isTimeslot(url)) {
        promise
          .then(function (res) { return res.clone().text(); })
          .then(recordTimeslots)
          .catch(function () {});
      }
      return promise;
    };

    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      if (isTimeslot(url)) {
        this.addEventListener('load', function () {
          try { recordTimeslots(this.responseText); } catch (e) {}
        });
      }
      return origOpen.apply(this, arguments);
    };
  }

  function freshTimesLine() {
    if (!state.times) return '';
    if (Date.now() - state.times.capturedAt.getTime() > TIMESLOT_FRESH_MS) return '';
    return '\nВремена (перехвачены с сайта в ' +
      state.times.capturedAt.toLocaleTimeString() + '): ' +
      state.times.times.join(', ');
  }

  // ------------------------------------------------------------- classify ---

  /* --8<-- classifyResponse --8<-- */
  // Maps an HTTP status + raw body to exactly one outcome.
  //
  // The critical rule, and the reason this function exists: an unrecognised
  // response shape is 'unknown-shape', NEVER 'no-slots'. The previous version
  // ended with a bare `else` that reported every unfamiliar payload as "свободных
  // слотов пока нет", so a single field rename on VFS's side would have had the
  // bot cheerfully reporting "no slots" forever while silently broken.
  function classifyResponse(httpStatus, rawText) {
    if (httpStatus === 401 || httpStatus === 403) {
      return { kind: 'session-expired', detail: 'HTTP ' + httpStatus };
    }
    if (httpStatus >= 500) {
      return { kind: 'server-error', detail: 'HTTP ' + httpStatus };
    }
    if (rawText == null || rawText === '') {
      return { kind: 'unknown-shape', detail: 'пустой ответ' };
    }

    var data;
    try {
      data = JSON.parse(rawText);
    } catch (e) {
      return { kind: 'unparseable', detail: String(rawText).slice(0, 200) };
    }
    if (data === null || typeof data !== 'object') {
      return { kind: 'unknown-shape', detail: String(rawText).slice(0, 200) };
    }

    if (data.earliestDate) {
      return { kind: 'slot', date: data.earliestDate };
    }

    // VFS reports "no availability" as an error object with an informational
    // code. That is a normal negative result, not a failure, so it is matched
    // before the generic error branch below.
    var err = data.error;
    if (err && typeof err === 'object') {
      if (err.code === 1035 || err.type === 'Information') {
        return { kind: 'no-slots' };
      }
      return { kind: 'server-error', detail: JSON.stringify(err).slice(0, 200) };
    }
    if (typeof err === 'string' && err) {
      return { kind: 'server-error', detail: err.slice(0, 200) };
    }

    // Some tenants answer with an explicit negative flag instead of an error.
    if (data.earliestDate === null || data.earliestDate === '') {
      return { kind: 'no-slots' };
    }

    return { kind: 'unknown-shape', detail: String(rawText).slice(0, 200) };
  }
  /* --8<-- end classifyResponse --8<-- */

  // ----------------------------------------------------------------- check ---

  function check() {
    if (state.expired) return;
    if (!state.active && !state.scanRequested) return;
    state.scanRequested = false;

    var jwt = sessionStorage.getItem('JWT');
    var email = sessionStorage.getItem('logged_email');
    if (!jwt) {
      expireNow('в этой вкладке нет JWT — вы не вошли в аккаунт');
      return;
    }

    if (!state.session) {
      state.session = readSession(jwt);
      scheduleExpiry();
    }

    var status = 0;
    fetch('https://lift-api.vfsglobal.com/appointment/CheckIsSlotAvailable', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        authorize: jwt,
        route: ROUTE
      },
      body: JSON.stringify(Object.assign({}, BODY, { loginUser: email }))
    })
      .then(function (r) {
        status = r.status;
        return r.text();
      })
      .then(function (raw) {
        state.lastCheckTime = new Date();
        var result = classifyResponse(status, raw);
        console.log('VFS-Bot проверка ' + state.lastCheckTime.toLocaleTimeString() + ':', result.kind, raw);

        if (result.kind === 'session-expired') {
          expireNow(result.detail);
          return;
        }

        if (result.kind === 'slot') {
          state.lastCheckText = 'slot found - ' + result.date;
          notify('🎉 VFS: ближайший доступный слот — ' + result.date + freshTimesLine());
          return;
        }

        if (result.kind === 'no-slots') {
          state.lastCheckText = 'no slots available';
          notify(
            'VFS-Bot: свободных слотов пока нет (проверено ' +
              state.lastCheckTime.toLocaleString() + ')',
            true // routine result -- delivered silently so it does not buzz all day
          );
          return;
        }

        if (result.kind === 'server-error') {
          state.lastCheckText = 'error - ' + result.detail;
          notify('VFS-Bot: сервер вернул ошибку: ' + result.detail);
          return;
        }

        // unparseable / unknown-shape: explicitly NOT "no slots".
        state.unknownShapeCount++;
        state.lastCheckText = 'unrecognised response - ' + result.detail;
        state.lastRawSample = result.detail;
        notify(
          '⚠️ VFS-Bot: не удалось разобрать ответ сервера.\n\n' +
            'Это НЕ значит, что слотов нет — значит, формат ответа изменился ' +
            'или сайт ответил чем-то неожиданным. Проверьте вручную.\n\n' +
            'Ответ: ' + result.detail
        );
      })
      .catch(function (e) {
        console.log('VFS-Bot: проверка не удалась', e);
        state.lastCheckTime = new Date();
        state.lastCheckText = 'error - network failure';
        notify('VFS-Bot: проверка не удалась (проблема сети).');
      });
  }

  // -------------------------------------------------------------- commands ---

  function formatStatus() {
    var lines = [
      'Status: ' +
        (state.expired
          ? '⛔ сессия истекла — войдите заново и нажмите закладку'
          : state.active
          ? '🟢 active'
          : '🔴 stopped')
    ];
    lines.push(describeSession());
    if (state.lastCheckTime) {
      lines.push('Last check: ' + state.lastCheckTime.toLocaleString());
      lines.push('Last result: ' + state.lastCheckText);
    } else {
      lines.push('No checks run yet');
    }
    if (state.times) {
      lines.push(
        'Времена (перехвачены ' + state.times.capturedAt.toLocaleTimeString() + '): ' +
          state.times.times.join(', ')
      );
    } else {
      lines.push('Времена слотов: не перехвачены — откройте выбор времени на сайте вручную');
    }
    if (state.unknownShapeCount) {
      lines.push('⚠️ неразобранных ответов: ' + state.unknownShapeCount);
    }
    return lines.join('\n');
  }

  function handleCommand(text) {
    // In groups Telegram suffixes commands with the bot's @username.
    var command = (text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();

    if (command === '/start') {
      if (state.expired) return '⛔ Сессия истекла — /start её не воскресит. Войдите заново и нажмите закладку.';
      state.active = true;
      return '✅ Проверка возобновлена.';
    }
    if (command === '/stop') {
      state.active = false;
      return '⏸️ Проверка приостановлена (команды по-прежнему слушаю).';
    }
    if (command === '/scan') {
      if (state.expired) return '⛔ Сессия истекла — /scan её не воскресит. Войдите заново и нажмите закладку.';
      state.scanRequested = true;
      check();
      return '🔍 Проверяю прямо сейчас.';
    }
    if (command === '/status') {
      return formatStatus();
    }
    return null;
  }

  // ------------------------------------------------------------------ boot ---

  if (window.__vfsBotRunning) {
    alert('VFS-Bot уже запущен на этой вкладке.');
    return;
  }
  if (RELAY_URL.indexOf('__') === 0 || USER_KEY.indexOf('__') === 0) {
    alert('VFS-Bot: закладка не сгенерирована до конца — возьмите ссылку со страницы установки.');
    return;
  }
  window.__vfsBotRunning = true;

  captureTimeslots();

  var bootJwt = sessionStorage.getItem('JWT');
  state.session = bootJwt ? readSession(bootJwt) : null;
  scheduleExpiry();

  check();
  window.__vfsBotInterval = setInterval(check, INTERVAL_MS);
  window.__vfsBotCommandInterval = setInterval(pollCommands, COMMAND_POLL_MS);

  notify(
    'VFS-Bot запущен. Проверка каждые 20 минут.\n' +
      describeSession() + '\n' +
      'Команды: /start /stop /scan /status'
  );
  alert(
    'VFS-Bot запущен — проверка каждые 20 минут, команды /start /stop /scan /status в Telegram.\n\n' +
      describeSession() + '\n\n' +
      'Не закрывайте эту вкладку (можно свернуть в фон).'
  );
})();
