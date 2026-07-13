# VFS-Bot — new user guide

Each user gets their own unique bookmark (one shared bot behind the scenes,
but every bookmark URL has that person's Telegram chat baked in — no
mix-ups if people share a computer or switch accounts).

## Onboarding a new user (you do this part, once per person)

1. **Have them open a chat with the bot.** In Telegram, they search for the
   bot and tap **Start** (or send it any message). Telegram won't let a bot
   message someone who hasn't done this.
2. **Get their chat ID.** Have them message **@userinfobot** (a free,
   well-known Telegram utility bot) — it replies instantly with their
   numeric ID, e.g. `715697717`. This number works with *any* bot's private
   chat with them, including this one.
3. **Generate their bookmark URL:**
   ```
   python3 generate_bookmarklet.py <their_chat_id>
   ```
   This prints a `javascript:...` URL. Send it to them and have them save
   it as a browser bookmark (any name, e.g. "VFS-Bot").

Each person's URL is unique to them — don't reuse one person's URL for
someone else, and regenerate (don't hand-edit) if `bookmarklet.js` ever
changes.

## Daily use (per user)

1. **Log into VFS normally**, in a regular browser tab — no automation, just
   your own login.
2. **Click your bookmark.** It starts scanning immediately (checks right
   away, then every 20 minutes) and sends a confirmation message to your
   Telegram chat.
3. **You're done.** Leave the tab open (it can sit in the background) and
   wait for Telegram to notify you when a slot appears.

You do **not** need to send `/start` after clicking the bookmark — scanning
is already active by default. `/start` is only for resuming after you've
sent `/stop`.

## Commands (send these to the bot in Telegram)

| Command | What it does |
|---|---|
| `/status` | Shows whether scanning is active and the result of the last check |
| `/stop` | Pauses scanning (the bot keeps listening for commands) |
| `/start` | Resumes scanning after a `/stop` |
| `/scan` | Forces an immediate check instead of waiting for the next interval |

Type `/` in the chat and Telegram will show these as a menu.

## If something goes wrong

- **"Your session expired" message**: your VFS login timed out. Log in
  again in that same tab, then click the bookmark again.
- **No reply to commands**: the tab must still be open — closing or
  reloading it stops everything, including the Telegram listener. Click the
  bookmark again to restart.
- **"Bot is already running in this tab"**: you clicked the bookmark twice
  in the same tab. Harmless — it's already running, no need to click again.
- **Commands feel delayed**: each scan can occasionally take up to ~2
  minutes if VFS is slow to respond; commands are still processed
  independently and shouldn't wait on that, but if you're not sure, `/status`
  always tells you the true current state.

## Good to know

- Each person's bookmark click is a fully separate session — your scan
  interval, your VFS login, your chat ID. Nobody else's activity affects
  yours.
- If someone switches Telegram accounts or a message ends up going to the
  wrong person, it means they're using the wrong bookmark (e.g. reused
  someone else's URL, or an old one from before it was regenerated) —
  re-run `generate_bookmarklet.py` for their correct chat ID and have them
  replace the bookmark.
- Keep checks reasonably infrequent (default: every 20 minutes). Hammering
  VFS's API too often is very plausibly what gets accounts flagged
  ("unusual activity" / access restricted) — don't lower `INTERVAL_MS`
  without a good reason.
