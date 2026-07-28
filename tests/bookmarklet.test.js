// Tests for the parts of the bookmarklet and relay that can be verified
// without a browser or a live VFS session.
//
// Run: npm test

process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '123456:TEST-TOKEN-NOT-REAL';

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
  const secret = process.env.TELEGRAM_BOT_TOKEN;
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
  assert.ok(!src.includes(".join(token)"), 'build must not splice a token into the page');
});
