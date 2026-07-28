// POST /api/notify  { chatId, key, text, silent? }
//
// The only way the bookmarklet can send a Telegram message. It can only ever
// reach its own chat: the key is an HMAC of that chat id, so it cannot be
// repurposed to message anyone else.

const { cors, readJson, verifyKey, sendMessage } = require('./_relay');

const MAX_TEXT = 3500;

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = await readJson(req);
  const chatId = body.chatId == null ? '' : String(body.chatId).trim();

  if (!verifyKey(chatId, body.key)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const text = typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT) : '';
  if (!text) {
    res.status(400).json({ error: 'empty_text' });
    return;
  }

  try {
    const sent = await sendMessage(chatId, text, { silent: body.silent === true });
    res.status(sent.ok ? 200 : 502).json({ ok: sent.ok });
  } catch (err) {
    res.status(502).json({ error: 'telegram_unreachable', detail: String(err && err.message) });
  }
};
