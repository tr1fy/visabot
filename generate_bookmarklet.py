#!/usr/bin/env python3
"""Generate a per-user VFS-Bot bookmarklet URL.

Usage:
    python3 generate_bookmarklet.py <chat_id>

<chat_id> is the user's numeric Telegram ID (get it by having them message
@userinfobot -- that number is also their private-chat ID with this bot).

Prints the `javascript:...` URL to stdout, ready to paste into a browser
bookmark's URL field.
"""
import re
import sys


def encode(s: str) -> str:
    out = []
    for ch in s:
        if ch == "\n":
            out.append("%0A")
        elif ch == "*":
            out.append("%2A")
        elif ch == "/":
            out.append("%2F")
        elif ord(ch) > 127:
            out.extend("%%%02X" % b for b in ch.encode("utf-8"))
        else:
            out.append(ch)
    return "".join(out)


def generate(chat_id: str, bot_token: str, source_path: str = "bookmarklet.js") -> str:
    if not re.fullmatch(r"-?\d+", chat_id):
        raise ValueError(f"chat_id must be numeric, got {chat_id!r}")
    if not bot_token:
        raise ValueError("bot_token is empty -- check telegram_bot_token in config.ini")

    with open(source_path, encoding="utf-8") as f:
        lines = f.readlines()

    start = next(i for i, l in enumerate(lines) if l.startswith("(function"))
    body = "".join(lines[start:])
    body = body.replace("__BOT_TOKEN__", bot_token)
    body = body.replace("__CHAT_ID__", chat_id)

    minified = "\n".join(line.lstrip() for line in body.split("\n"))
    return "javascript:" + encode(minified)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)

    from vfsbot.config import load_config

    cfg = load_config("config.ini")
    print(generate(sys.argv[1], cfg.telegram_bot_token))
