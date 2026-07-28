// GET /api/commands?chatId=...&key=...&after=<update_id>
//
// Replaces the browser calling Telegram's getUpdates directly. Two things that
// fixes:
//
//   1. getUpdates returns updates for the WHOLE bot. Every user's tab used to
//      see every other user's chat id and commands. Here the response is
//      filtered to the caller's own chat, which the key proves they own.
//   2. The old code never passed `offset`, so Telegram's backlog grew for 24h
//      and each of N tabs re-downloaded all of it every 4 seconds.
//
// Confirming updates is delicate: `offset` acknowledges updates for the whole
// bot, so confirming eagerly would drop commands other users have not collected
// yet. Instead we only confirm updates older than SAFETY_WINDOW_MS — long past
// the point any live tab would still need them. That bounds the backlog without
// any shared storage, which serverless functions do not have.

const { cors, verifyKey, telegram } = require('./_relay');

const CACHE_TTL_MS = 2_000;
const SAFETY_WINDOW_MS = 10 * 60 * 1000;

let cache = { at: 0, updates: [] };
let inflight = null;
let commandsRegistered = false;

async function registerCommandsOnce() {
  if (commandsRegistered) return;
  commandsRegistered = true;
  try {
    await telegram('setMyCommands', {
      commands: [
        { command: 'start', description: 'Возобновить проверку' },
        { command: 'stop', description: 'Приостановить проверку' },
        { command: 'scan', description: 'Проверить прямо сейчас' },
        { command: 'status', description: 'Состояние и результат последней проверки' },
      ],
    });
  } catch {
    commandsRegistered = false; // let a later invocation try again
  }
}

async function confirmOldUpdates(updates) {
  const cutoffSec = (Date.now() - SAFETY_WINDOW_MS) / 1000;
  let highestOld = 0;
  for (const u of updates) {
    const msg = u.message || u.channel_post;
    const date = msg && typeof msg.date === 'number' ? msg.date : 0;
    if (date && date < cutoffSec && u.update_id > highestOld) highestOld = u.update_id;
  }
  if (!highestOld) return;
  try {
    // offset = N acknowledges everything up to N-1 and leaves newer updates.
    await telegram('getUpdates', null, { query: { offset: highestOld + 1, limit: 1, timeout: 0 } });
  } catch {
    // Non-fatal: the backlog just stays a little longer.
  }
}

async function fetchUpdates() {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS) return cache.updates;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const res = await telegram('getUpdates', null, { query: { timeout: 0, limit: 100 } });
      if (!res.data || res.data.ok !== true) {
        // 409 means another getUpdates was in flight; treat as "nothing new".
        return cache.updates;
      }
      const updates = Array.isArray(res.data.result) ? res.data.result : [];
      cache = { at: Date.now(), updates };
      void confirmOldUpdates(updates);
      return updates;
    } catch {
      return cache.updates;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const chatId = (url.searchParams.get('chatId') || '').trim();
  const key = url.searchParams.get('key') || '';
  const after = Number.parseInt(url.searchParams.get('after') || '', 10);

  if (!verifyKey(chatId, key)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  void registerCommandsOnce();

  const updates = await fetchUpdates();
  const mine = [];
  let maxUpdateId = Number.isFinite(after) ? after : 0;

  for (const u of updates) {
    if (u.update_id > maxUpdateId) maxUpdateId = u.update_id;
    if (Number.isFinite(after) && u.update_id <= after) continue;
    const msg = u.message || u.channel_post;
    if (!msg || !msg.chat || String(msg.chat.id) !== chatId) continue;
    mine.push({ updateId: u.update_id, text: typeof msg.text === 'string' ? msg.text : '' });
  }

  // `cursor` is what the caller should send back as `after` next time. When the
  // caller is brand new (no `after`), it gets the current high-water mark and no
  // messages, so a fresh tab never replays old commands.
  res.status(200).json({
    cursor: maxUpdateId,
    bootstrap: !Number.isFinite(after),
    commands: Number.isFinite(after) ? mine : [],
  });
};
