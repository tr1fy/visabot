// Tests for the parts of the bookmarklet and relay that can be verified
// without a browser or a live VFS session.
//
// Run: npm test

process.env.TELEGRAM_BOT_TOKEN = '123456:TEST-TOKEN-NOT-REAL';
// Deliberately different from the token: user keys must not be coupled to it,
// so that rotating the token does not invalidate everyone's bookmarklet.
process.env.RELAY_SECRET = 'test-relay-secret-at-least-16-chars';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

// --- extract classifyResponse straight out of the bookmarklet -------------
// The bookmarklet must stay a single self-contained IIFE, so the function
// cannot simply be imported. Lifting it out by its markers lets us test the
// real shipped source rather than a copy that can drift.
function loadClassifyResponse() {
  const src = fs.readFileSync(path.join(ROOT, 'bookmarklet.js'), 'utf8');
  const start = src.indexOf('/* --8<-- classifyResponse --8<-- */');
  const end = src.indexOf('/* --8<-- end classifyResponse --8<-- */');
  assert.ok(start !== -1 && end !== -1, 'classifyResponse markers missing from bookmarklet.js');
  const body = src.slice(start, end);
  // eslint-disable-next-line no-new-func
  return new Function(`${body}; return classifyResponse;`)();
}

const classifyResponse = loadClassifyResponse();

test('slot found is reported as a slot', () => {
  const r = classifyResponse(200, JSON.stringify({ earliestDate: '2026-08-14' }));
  assert.deepStrictEqual(r, { kind: 'slot', date: '2026-08-14' });
});

test("VFS's informational 1035 is a genuine 'no slots', not an error", () => {
  const r = classifyResponse(
    200,
    JSON.stringify({ error: { code: 1035, type: 'Information', description: 'no slots' } }),
  );
  assert.strictEqual(r.kind, 'no-slots');
});

test("error.type 'Information' also counts as no slots", () => {
  const r = classifyResponse(200, JSON.stringify({ error: { type: 'Information' } }));
  assert.strictEqual(r.kind, 'no-slots');
});

test('an explicit null earliestDate is no slots', () => {
  assert.strictEqual(classifyResponse(200, JSON.stringify({ earliestDate: null })).kind, 'no-slots');
});

test('a real error object is a server error', () => {
  const r = classifyResponse(200, JSON.stringify({ error: { code: 500, type: 'Error' } }));
  assert.strictEqual(r.kind, 'server-error');
});

test('a string error is a server error', () => {
  assert.strictEqual(classifyResponse(200, JSON.stringify({ error: 'boom' })).kind, 'server-error');
});

test('401 and 403 mean the session expired', () => {
  assert.strictEqual(classifyResponse(401, '').kind, 'session-expired');
  assert.strictEqual(classifyResponse(403, '').kind, 'session-expired');
});

test('5xx is a server error, not a missing slot', () => {
  assert.strictEqual(classifyResponse(502, 'Bad Gateway').kind, 'server-error');
});

// --- the regression this whole exercise exists for -----------------------

test('REGRESSION: an unrecognised JSON shape is NEVER reported as no-slots', () => {
  // The old code ended in a bare `else` that called anything it did not
  // recognise "свободных слотов пока нет". One field rename on VFS's side and
  // the bot would report no availability forever while silently broken.
  const renamed = JSON.stringify({ nearestAvailableDate: '2026-08-14', status: 'OK' });
  const r = classifyResponse(200, renamed);
  assert.strictEqual(r.kind, 'unknown-shape');
  assert.notStrictEqual(r.kind, 'no-slots');
});

test('REGRESSION: an empty body is not no-slots', () => {
  assert.strictEqual(classifyResponse(200, '').kind, 'unknown-shape');
});

test('REGRESSION: an HTML error page is not no-slots', () => {
  const r = classifyResponse(200, '<!doctype html><html><body>Access Denied</body></html>');
  assert.strictEqual(r.kind, 'unparseable');
});

test('REGRESSION: a bare JSON scalar is not no-slots', () => {
  assert.strictEqual(classifyResponse(200, '"ok"').kind, 'unknown-shape');
  assert.strictEqual(classifyResponse(200, 'null').kind, 'unknown-shape');
});

// --- relay auth ----------------------------------------------------------

const relay = require('../api/_relay.js');

test('a derived key verifies for its own chat and no other', () => {
  const key = relay.deriveKey('715697717');
  assert.strictEqual(key.length, 32);
  assert.ok(relay.verifyKey('715697717', key));
  assert.ok(!relay.verifyKey('715697718', key), 'key must not work for a different chat');
});

test('garbage keys are rejected without throwing', () => {
  assert.ok(!relay.verifyKey('715697717', ''));
  assert.ok(!relay.verifyKey('715697717', 'x'.repeat(32)));
  assert.ok(!relay.verifyKey('715697717', undefined));
  assert.ok(!relay.verifyKey('not-a-chat', relay.deriveKey('not-a-chat')));
});

test('chat id validation rejects non-numeric input', () => {
  assert.ok(relay.isValidChatId('-100123'));
  assert.ok(!relay.isValidChatId('12a'));
  assert.ok(!relay.isValidChatId(''));
  assert.ok(!relay.isValidChatId('1'.repeat(30)));
});

test('enrolment codes verify within the window and reject wrong codes', () => {
  const chatId = '715697717';
  assert.ok(relay.verifyCode(chatId, relay.codeFor(chatId)));
  assert.ok(relay.verifyCode(chatId, relay.codeFor(chatId, 1)), 'previous window must still pass');
  assert.ok(!relay.verifyCode(chatId, '000000') || relay.codeFor(chatId) === '000000');
  assert.ok(!relay.verifyCode(chatId, relay.codeFor('999999999')));
  assert.ok(!relay.verifyCode(chatId, 'abcdef'));
  assert.ok(!relay.verifyCode(chatId, '12345'));
});

// --- the Python generator must mint identical keys ------------------------

test('generate_bookmarklet.py derives the same key as the relay', () => {
  const chatId = '715697717';
  const secret = process.env.RELAY_SECRET;
  let fromPython;
  try {
    fromPython = execFileSync(
      'python3',
      [
        '-c',
        'import sys; sys.path.insert(0, ".."); ' +
          'from generate_bookmarklet import derive_key; ' +
          `print(derive_key(${JSON.stringify(chatId)}, ${JSON.stringify(secret)}))`,
      ],
      { cwd: __dirname, encoding: 'utf8' },
    ).trim();
  } catch (err) {
    assert.fail(`could not run the Python generator: ${err.message}`);
  }
  assert.strictEqual(fromPython, relay.deriveKey(chatId));
});

// --- URL encoding of the bookmarklet body --------------------------------

test('REGRESSION: the generated URL is a well-formed percent-encoded string', () => {
  // The bookmarklet body contains a modulo operator (`b64.length % 4`). A bare
  // '%' reads as the start of a percent-escape, so before this was escaped the
  // browser either mangled or truncated the script when decoding the URL.
  const url = execFileSync(
    'python3',
    [
      '-c',
      'import sys; sys.path.insert(0, ".."); ' +
        'from generate_bookmarklet import generate; ' +
        'print(generate("715697717", "test-secret", "https://relay.example", "../bookmarklet.js"))',
    ],
    { cwd: __dirname, encoding: 'utf8' },
  ).trim();

  assert.ok(url.startsWith('javascript:'), 'must be a javascript: URL');
  const payload = url.slice('javascript:'.length);

  let decoded;
  assert.doesNotThrow(() => {
    decoded = decodeURIComponent(payload);
  }, 'generated URL must survive decodeURIComponent');

  // The modulo survived the round trip intact.
  assert.ok(decoded.includes('% 4'), 'the modulo operator must round-trip');
  assert.ok(decoded.includes('https://relay.example'), 'relay URL must round-trip');
  assert.ok(decoded.includes('715697717'), 'chat id must round-trip');
  // Nothing was cut off at a fragment boundary.
  assert.ok(decoded.trimEnd().endsWith('})();'), 'script must not be truncated');
});

// --- the token must never reach the browser again ------------------------

test('the shipped bookmarklet body never touches the bot token or Telegram directly', () => {
  // Only the IIFE is shipped -- build_guide.js slices from the `(function` line,
  // so the header comments (which discuss the old behaviour by name) are stripped.
  const src = fs.readFileSync(path.join(ROOT, 'bookmarklet.js'), 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith('(function'));
  assert.ok(start !== -1, 'could not find the IIFE start');
  const body = lines.slice(start).join('\n');

  assert.ok(!body.includes('__BOT_TOKEN__'), 'bookmarklet must not carry the bot token');
  assert.ok(!/api\.telegram\.org/.test(body), 'bookmarklet must talk to the relay, not Telegram');
  assert.ok(!/getUpdates/.test(body), 'command polling must go through the relay');
  assert.ok(!/simulateActivity/.test(body), 'synthetic activity was removed deliberately');
  assert.ok(body.includes('__RELAY_URL__'), 'relay URL placeholder must be present');
  assert.ok(body.includes('__USER_KEY__'), 'per-user key placeholder must be present');
});

test('build_guide.js does not substitute the bot token', () => {
  const src = fs.readFileSync(path.join(ROOT, 'build_guide.js'), 'utf8');
  assert.ok(!src.includes('.join(token)'), 'build must not splice a token into the page');
});

test('the diagnostic bookmarklet carries no token either', () => {
  const src = fs.readFileSync(path.join(ROOT, 'diagnostic_bookmarklet.js'), 'utf8');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith('(function'));
  const body = lines.slice(start).join('\n');
  assert.ok(!body.includes('__BOT_TOKEN__'), 'diagnostic must not carry the bot token');
  assert.ok(!/api\.telegram\.org/.test(body), 'diagnostic must report through the relay');
  assert.ok(body.includes('__USER_KEY__'), 'diagnostic needs a per-user key');
});

test('the guide template hardcodes no bot username', () => {
  // Running your own bot must not leave the page telling users to press Start
  // on somebody else's.
  const src = fs.readFileSync(path.join(ROOT, 'guide_template.html'), 'utf8');
  assert.ok(!src.includes('vfsreg_bot'), 'bot username must come from __BOT_USERNAME__');
  assert.ok(src.includes('__BOT_USERNAME__'), 'placeholder must be present');
});

test('build_guide.py does not substitute the bot token', () => {
  const src = fs.readFileSync(path.join(ROOT, 'build_guide.py'), 'utf8');
  assert.ok(
    !src.includes('cfg.telegram_bot_token'),
    'the local builder must not splice a token into guide.html either',
  );
});

// --- RELAY_SECRET must be independent of the bot token --------------------

test('the relay refuses to start without a usable RELAY_SECRET', () => {
  const saved = process.env.RELAY_SECRET;
  try {
    delete process.env.RELAY_SECRET;
    assert.throws(() => relay.deriveKey('715697717'), /RELAY_SECRET is missing/);

    process.env.RELAY_SECRET = 'tooshort';
    assert.throws(() => relay.deriveKey('715697717'), /shorter than/);
  } finally {
    process.env.RELAY_SECRET = saved;
  }
});

test('keys survive a bot-token rotation', () => {
  // The whole point of a separate secret: change the token, keys stay valid,
  // nobody's bookmarklet breaks.
  const before = relay.deriveKey('715697717');
  const savedToken = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.TELEGRAM_BOT_TOKEN = '999999:A-COMPLETELY-DIFFERENT-TOKEN';
    assert.strictEqual(relay.deriveKey('715697717'), before);
  } finally {
    process.env.TELEGRAM_BOT_TOKEN = savedToken;
  }
});

// --- request handlers -----------------------------------------------------

function mockRes() {
  const r = { statusCode: null, body: null, headers: {}, ended: false };
  r.setHeader = (k, v) => {
    r.headers[k] = v;
  };
  r.status = (c) => {
    r.statusCode = c;
    return r;
  };
  r.json = (b) => {
    r.body = b;
    return r;
  };
  r.end = () => {
    r.ended = true;
    return r;
  };
  return r;
}

function withFetch(impl, fn) {
  const saved = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    global.fetch = saved;
  });
}

const jsonResponse = (payload) => ({
  ok: true,
  status: 200,
  json: async () => payload,
});

test('notify refuses a key that does not match the chat, and calls nobody', async () => {
  const handler = require('../api/notify.js');
  await withFetch(
    () => jsonResponse({ ok: true }),
    async (calls) => {
      const res = mockRes();
      await handler({ method: 'POST', body: { chatId: '715697717', key: 'x'.repeat(32), text: 'hi' } }, res);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(calls.length, 0, 'must not reach Telegram on a bad key');
    },
  );
});

test('notify sends to the caller`s own chat with a valid key', async () => {
  const handler = require('../api/notify.js');
  const chatId = '715697717';
  await withFetch(
    () => jsonResponse({ ok: true }),
    async (calls) => {
      const res = mockRes();
      await handler(
        { method: 'POST', body: { chatId, key: relay.deriveKey(chatId), text: 'hello' } },
        res,
      );
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(calls.length, 1);
      assert.match(calls[0].url, /sendMessage$/);
      const sent = JSON.parse(calls[0].init.body);
      assert.strictEqual(sent.chat_id, chatId);
      assert.strictEqual(sent.text, 'hello');
    },
  );
});

test('notify rejects empty text', async () => {
  const handler = require('../api/notify.js');
  const chatId = '715697717';
  await withFetch(
    () => jsonResponse({ ok: true }),
    async () => {
      const res = mockRes();
      await handler({ method: 'POST', body: { chatId, key: relay.deriveKey(chatId), text: '' } }, res);
      assert.strictEqual(res.statusCode, 400);
    },
  );
});

test('commands returns only the caller`s own chat, never anyone else`s', async () => {
  const handler = require('../api/commands.js');
  const mine = '715697717';
  const theirs = '999888777';
  const updates = [
    { update_id: 10, message: { chat: { id: Number(theirs) }, text: '/stop', date: Date.now() / 1000 } },
    { update_id: 11, message: { chat: { id: Number(mine) }, text: '/status', date: Date.now() / 1000 } },
  ];

  await withFetch(
    () => jsonResponse({ ok: true, result: updates }),
    async () => {
      const res = mockRes();
      const url = `/api/commands?chatId=${mine}&key=${relay.deriveKey(mine)}&after=5`;
      await handler({ method: 'GET', url }, res);

      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.body.commands.length, 1);
      assert.strictEqual(res.body.commands[0].text, '/status');
      assert.strictEqual(res.body.cursor, 11);
      const serialised = JSON.stringify(res.body);
      assert.ok(!serialised.includes(theirs), "another user's chat id must never be returned");
      assert.ok(!serialised.includes('/stop'), "another user's command must never be returned");
    },
  );
});

test('commands rejects a bad key before touching Telegram', async () => {
  const handler = require('../api/commands.js');
  await withFetch(
    () => jsonResponse({ ok: true, result: [] }),
    async (calls) => {
      const res = mockRes();
      await handler({ method: 'GET', url: '/api/commands?chatId=715697717&key=nope' }, res);
      assert.strictEqual(res.statusCode, 403);
      assert.strictEqual(calls.length, 0);
    },
  );
});

test('enroll rejects a non-numeric chat id without messaging anyone', async () => {
  const handler = require('../api/enroll.js');
  await withFetch(
    () => jsonResponse({ ok: true }),
    async (calls) => {
      const res = mockRes();
      await handler({ method: 'POST', body: { chatId: 'not-a-chat' } }, res);
      assert.strictEqual(res.statusCode, 400);
      assert.strictEqual(res.body.error, 'bad_chat_id');
      assert.strictEqual(calls.length, 0);
    },
  );
});

test('enroll hands back a key only for a correct code', async () => {
  const handler = require('../api/enroll.js');
  const chatId = '715697717';
  await withFetch(
    () => jsonResponse({ ok: true }),
    async () => {
      const bad = mockRes();
      await handler({ method: 'POST', body: { chatId, code: '000000' } }, bad);
      // 000000 is a valid code only in the astronomically unlikely case it matches
      if (relay.codeFor(chatId) !== '000000') {
        assert.strictEqual(bad.statusCode, 400);
        assert.strictEqual(bad.body.error, 'bad_code');
      }

      const good = mockRes();
      await handler({ method: 'POST', body: { chatId, code: relay.codeFor(chatId) } }, good);
      assert.strictEqual(good.statusCode, 200);
      assert.strictEqual(good.body.key, relay.deriveKey(chatId));
    },
  );
});
