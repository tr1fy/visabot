// Shared helpers for the relay functions.
//
// Why a relay exists at all: the bookmarklet used to carry the real Telegram
// bot token, which meant (a) build_guide.js published the token inside a public
// page on Vercel, and (b) every user's tab could call getUpdates and read every
// other user's chat id and commands. The token now lives only in this server's
// environment; the browser gets a per-user key that can do nothing but talk to
// its own chat.

const crypto = require('crypto');

const TELEGRAM_API = 'https://api.telegram.org/bot';

function botToken() {
  const t = process.env.TELEGRAM_BOT_TOKEN;
  if (!t) throw new Error('TELEGRAM_BOT_TOKEN is not set on the server');
  return t;
}

const MIN_SECRET_LENGTH = 16;

// Deliberately independent of TELEGRAM_BOT_TOKEN.
//
// An earlier version fell back to the bot token when RELAY_SECRET was unset,
// which quietly coupled the two: rotating the token would have invalidated
// every issued user key and broken every user's bookmarklet at once. That cost
// is exactly what makes people postpone rotating a leaked token. Keeping the
// secret separate makes token rotation free, so it can happen whenever it needs
// to.
function relaySecret() {
  const s = process.env.RELAY_SECRET;
  if (!s || s.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `RELAY_SECRET is missing or shorter than ${MIN_SECRET_LENGTH} characters. Generate one with:\n` +
        `  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"\n` +
        'and set it in the project environment. Do NOT reuse TELEGRAM_BOT_TOKEN: keeping ' +
        'them separate is what lets you rotate the bot token without invalidating every ' +
        "user's bookmarklet.",
    );
  }
  return s;
}

function isValidChatId(chatId) {
  return typeof chatId === 'string' && /^-?\d{1,20}$/.test(chatId);
}

/** Stable per-user credential. Knowing a chat id is not enough to mint one. */
function deriveKey(chatId) {
  return crypto
    .createHmac('sha256', relaySecret())
    .update(`vfsbot-key-v1:${chatId}`)
    .digest('base64url')
    .slice(0, 32);
}

function verifyKey(chatId, key) {
  if (!isValidChatId(chatId) || typeof key !== 'string' || key.length !== 32) return false;
  const expected = deriveKey(chatId);
  const a = Buffer.from(expected);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const CODE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Six-digit enrolment code, derived rather than stored — serverless functions
 * have no shared state, and a code that is a pure function of (chat id, time
 * window) needs none. Proof of ownership comes from the code being delivered
 * into that Telegram chat.
 */
function codeFor(chatId, windowOffset = 0) {
  const window = Math.floor(Date.now() / CODE_WINDOW_MS) - windowOffset;
  const digest = crypto
    .createHmac('sha256', relaySecret())
    .update(`vfsbot-code-v1:${chatId}:${window}`)
    .digest();
  return String(digest.readUInt32BE(0) % 1000000).padStart(6, '0');
}

function verifyCode(chatId, code) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  // Accept the previous window too, so a code does not die mid-typing.
  return [0, 1].some((offset) => {
    const expected = Buffer.from(codeFor(chatId, offset));
    const given = Buffer.from(code);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}

async function telegram(method, payload, { query } = {}) {
  const url =
    `${TELEGRAM_API}${botToken()}/${method}` + (query ? `?${new URLSearchParams(query)}` : '');
  const res = await fetch(url, {
    method: payload ? 'POST' : 'GET',
    ...(payload
      ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
      : {}),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, status: res.status, data };
}

function sendMessage(chatId, text, { silent = false } = {}) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    ...(silent ? { disable_notification: true } : {}),
  });
}

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function readJson(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 64_000) raw = raw.slice(0, 64_000);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

module.exports = {
  botToken,
  relaySecret,
  isValidChatId,
  deriveKey,
  verifyKey,
  codeFor,
  verifyCode,
  telegram,
  sendMessage,
  cors,
  readJson,
  CODE_WINDOW_MS,
};
