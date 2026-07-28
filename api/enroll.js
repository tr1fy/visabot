// POST /api/enroll
//
// Two steps, both stateless:
//   { chatId }         -> sends a 6-digit code into that Telegram chat
//   { chatId, code }   -> verifies the code, returns the per-user key
//
// The code proves the requester can read that chat. Without this, anyone who
// knew your numeric chat id could mint a key and make the bot message you.

const { cors, readJson, isValidChatId, codeFor, verifyCode, deriveKey, sendMessage } = require('./_relay');

module.exports = async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch {
    res.status(400).json({ error: 'bad_request' });
    return;
  }

  const chatId = body.chatId == null ? '' : String(body.chatId).trim();
  if (!isValidChatId(chatId)) {
    res.status(400).json({ error: 'bad_chat_id' });
    return;
  }

  try {
    if (!body.code) {
      const code = codeFor(chatId);
      const sent = await sendMessage(
        chatId,
        `Код подтверждения VFS-Bot: ${code}\n\n` +
          'Введите его на странице установки. Код действует 10 минут.\n' +
          'Если вы этого не запрашивали — просто проигнорируйте сообщение.',
      );
      if (!sent.ok || !sent.data || sent.data.ok !== true) {
        // Almost always means the user never pressed Start in the bot.
        res.status(400).json({
          error: 'cannot_message_chat',
          detail: 'Откройте бота в Telegram и нажмите Start, затем повторите.',
        });
        return;
      }
      res.status(200).json({ sent: true });
      return;
    }

    if (!verifyCode(chatId, String(body.code).trim())) {
      res.status(400).json({ error: 'bad_code' });
      return;
    }

    res.status(200).json({ key: deriveKey(chatId) });
  } catch (err) {
    res.status(500).json({ error: 'server_error', detail: String(err && err.message) });
  }
};
