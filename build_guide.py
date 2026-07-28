#!/usr/bin/env python3
"""Build guide.html from guide_template.html + bookmarklet.js.

Local counterpart of build_guide.js, which is what Vercel runs to produce
public/index.html. Run this whenever bookmarklet.js changes, so the in-page
generator never drifts from the actual bot behaviour.

Usage:
    python3 build_guide.py

This no longer bakes the Telegram bot token into the output. It used to, and
the Vercel equivalent published the result publicly -- see the security note at
the top of bookmarklet.js and RELAY.md. The token now stays in the relay's
server environment; the page asks /api/enroll for a per-user key at runtime.

Reads the relay URL from [RELAY] url in config.ini.
"""
import json

from vfsbot.config import load_config


def extract_bookmarklet_source(path: str = "bookmarklet.js", relay_url: str = "") -> str:
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    start = next(i for i, l in enumerate(lines) if l.startswith("(function"))
    body = "".join(lines[start:])
    source = "\n".join(line.lstrip() for line in body.split("\n"))

    if "__BOT_TOKEN__" in source:
        raise ValueError(
            f"{path} still references __BOT_TOKEN__ -- refusing to build. "
            "The token must never be shipped to the browser."
        )
    if not relay_url:
        raise ValueError("relay url is empty -- set [RELAY] url in config.ini")

    # __CHAT_ID__ and __USER_KEY__ stay as placeholders: the page fills them in
    # per visitor, after /api/enroll has verified they control that chat.
    return source.replace("__RELAY_URL__", relay_url.rstrip("/"))


def build(template_path: str = "guide_template.html", out_path: str = "guide.html") -> None:
    cfg = load_config("config.ini")
    relay_url = (cfg.relay_url or "").rstrip("/")
    source = extract_bookmarklet_source(relay_url=relay_url)

    # Which Telegram bot the guide tells people to press Start on. Defaults to
    # the original so existing builds are unchanged; set [RELAY] bot_username
    # when running your own bot, or the page sends users to somebody else's.
    bot_username = (getattr(cfg, "bot_username", "") or "vfsreg_bot").lstrip("@")

    with open(template_path, encoding="utf-8") as f:
        template = f.read()
    # json.dumps produces a valid, safely-escaped JS string literal (handles
    # backslashes, quotes, backticks, newlines) for embedding in <script>.
    injected = template.replace("__BOOKMARKLET_SOURCE_JSON__", json.dumps(source))
    injected = injected.replace("__RELAY_URL__", relay_url)
    injected = injected.replace("__BOT_USERNAME__", bot_username)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(injected)
    print(f"wrote {out_path} ({len(injected)} chars), relay {relay_url}, bot @{bot_username}")


if __name__ == "__main__":
    build()
