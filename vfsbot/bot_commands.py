# VFS-Bot-v2/vfsbot/bot_commands.py
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

import requests

from vfsbot.telegram import get_updates, send_message

COMMANDS = [
    ("start", "Resume scanning"),
    ("stop", "Pause scanning (bot keeps listening for commands)"),
    ("scan", "Run a scan immediately"),
    ("status", "Show whether the bot is active and the last check result"),
]


@dataclass
class BotState:
    active: bool = True
    scan_requested: bool = False
    last_result: Optional[Any] = None


def format_status(state: BotState) -> str:
    lines = [f"Status: {'🟢 active' if state.active else '🔴 stopped'}"]
    result = state.last_result
    if result is None:
        lines.append("No checks run yet")
        return "\n".join(lines)

    lines.append(f"Last check: {result.timestamp.strftime('%Y-%m-%d %H:%M:%S')}")
    if result.error:
        lines.append(f"Last result: error - {result.error}")
    elif result.slot_date:
        lines.append(f"Last result: slot found - {result.slot_date.isoformat()}")
    else:
        lines.append("Last result: no slots available")
    return "\n".join(lines)


def handle_command(text: str, state: BotState) -> Optional[str]:
    # In groups Telegram may suffix commands with the bot's @username
    # (e.g. "/status@vfsreg_bot") to disambiguate between multiple bots --
    # strip that before matching, or every command silently gets ignored
    # in group chats.
    command = text.strip().split()[0].split("@")[0].lower() if text.strip() else ""
    if command == "/start":
        state.active = True
        return "✅ Bot started. Scanning resumed."
    if command == "/stop":
        state.active = False
        return "⏸️ Bot stopped. Scanning paused (still listening for commands)."
    if command == "/scan":
        state.scan_requested = True
        return "🔍 Manual scan queued, will run shortly."
    if command == "/status":
        return format_status(state)
    return None


def poll_commands(
    bot_token: str,
    allowed_chat_id: str,
    state: BotState,
    stop_fn: Callable[[], bool] = lambda: False,
    sleep_fn: Callable[[float], None] = time.sleep,
    get_updates_fn: Callable[..., list] = get_updates,
    send_message_fn: Callable[[str, str, str], None] = send_message,
) -> None:
    offset = None
    while not stop_fn():
        try:
            updates = get_updates_fn(bot_token, offset=offset, timeout=30)
        except requests.RequestException:
            sleep_fn(5)
            continue

        for update in updates:
            offset = update["update_id"] + 1
            message = update.get("message") or update.get("channel_post")
            if not message:
                continue
            chat_id = str(message.get("chat", {}).get("id", ""))
            if chat_id != str(allowed_chat_id):
                continue
            reply = handle_command(message.get("text", ""), state)
            if reply:
                send_message_fn(bot_token, allowed_chat_id, reply)
