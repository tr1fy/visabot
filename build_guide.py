#!/usr/bin/env python3
"""Build guide.html from guide_template.html + bookmarklet.js.

Run this whenever bookmarklet.js changes, so the in-page generator always
matches the actual bot behavior instead of drifting out of sync.

Usage:
    python3 build_guide.py

Reads telegram_bot_token from config.ini (gitignored, never committed) and
bakes it into the built guide.html. guide.html itself is also gitignored --
it's a local build artifact containing a live credential, meant to be
deployed by hand, never pushed to source control.
"""
import json

from vfsbot.config import load_config


def extract_bookmarklet_source(path: str = "bookmarklet.js") -> str:
    with open(path, encoding="utf-8") as f:
        lines = f.readlines()
    start = next(i for i, l in enumerate(lines) if l.startswith("(function"))
    body = "".join(lines[start:])
    source = "\n".join(line.lstrip() for line in body.split("\n"))

    cfg = load_config("config.ini")
    if not cfg.telegram_bot_token:
        raise ValueError("telegram_bot_token is empty in config.ini")
    return source.replace("__BOT_TOKEN__", cfg.telegram_bot_token)


def build(template_path: str = "guide_template.html", out_path: str = "guide.html") -> None:
    source = extract_bookmarklet_source()
    with open(template_path, encoding="utf-8") as f:
        template = f.read()
    # json.dumps produces a valid, safely-escaped JS string literal (handles
    # backslashes, quotes, backticks, newlines) for embedding in <script>.
    injected = template.replace("__BOOKMARKLET_SOURCE_JSON__", json.dumps(source))
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(injected)
    print(f"wrote {out_path} ({len(injected)} chars)")


if __name__ == "__main__":
    build()
