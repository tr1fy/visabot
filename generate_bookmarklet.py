#!/usr/bin/env python3
"""Generate a per-user VFS-Bot bookmarklet URL.

Usage:
    python3 generate_bookmarklet.py <chat_id> [relay_url]

<chat_id> is the user's numeric Telegram ID (get it by having them message
@userinfobot -- that number is also their private-chat ID with this bot).

<relay_url> defaults to the relay_url value in config.ini, or the RELAY_URL
environment variable.

Prints the `javascript:...` URL to stdout, ready to paste into a browser
bookmark's URL field.

This is the operator-side path: it mints the user key offline from the shared
secret. Users onboarding themselves through the public guide page get the same
key from /api/enroll instead, after confirming a code sent to their chat.

Note: the bot token is NOT embedded in the bookmarklet any more. It stays in
the relay's server environment. See the security note at the top of
bookmarklet.js.
"""
import base64
import hashlib
import hmac
import os
import re
import sys


def derive_key(chat_id: str, secret: str) -> str:
    """Must stay byte-for-byte identical to deriveKey() in api/_relay.js."""
    digest = hmac.new(
        secret.encode("utf-8"),
        f"vfsbot-key-v1:{chat_id}".encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:32]


def encode(s: str) -> str:
    out = []
    for ch in s:
        if ch == "%":
            # Must come first: a bare '%' in the source (the modulo operator in
            # decodeJwtPayload) reads as the start of a percent-escape and
            # corrupts the bookmarklet when the browser decodes the URL.
            out.append("%25")
        elif ch == "#":
            # A bare '#' would start the URL fragment and cut the script off.
            out.append("%23")
        elif ch == "\n":
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


def generate(
    chat_id: str,
    secret: str,
    relay_url: str,
    source_path: str = "bookmarklet.js",
) -> str:
    if not re.fullmatch(r"-?\d+", chat_id):
        raise ValueError(f"chat_id must be numeric, got {chat_id!r}")
    if not secret:
        raise ValueError("secret is empty -- set relay_secret or telegram_bot_token in config.ini")
    if not relay_url:
        raise ValueError("relay_url is empty -- set it in config.ini or pass it as an argument")

    with open(source_path, encoding="utf-8") as f:
        lines = f.readlines()

    start = next(i for i, l in enumerate(lines) if l.startswith("(function"))
    body = "".join(lines[start:])

    if "__BOT_TOKEN__" in body:
        raise ValueError(
            "bookmarklet.js still references __BOT_TOKEN__ -- refusing to generate. "
            "The token must never be shipped to the browser."
        )

    body = body.replace("__RELAY_URL__", relay_url.rstrip("/"))
    body = body.replace("__CHAT_ID__", chat_id)
    body = body.replace("__USER_KEY__", derive_key(chat_id, secret))

    minified = "\n".join(line.lstrip() for line in body.split("\n"))
    return "javascript:" + encode(minified)


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        print(__doc__)
        sys.exit(1)

    from vfsbot.config import load_config

    cfg = load_config("config.ini")
    secret = getattr(cfg, "relay_secret", "") or cfg.telegram_bot_token
    relay_url = (
        sys.argv[2]
        if len(sys.argv) == 3
        else (getattr(cfg, "relay_url", "") or os.environ.get("RELAY_URL", ""))
    )

    print(generate(sys.argv[1], secret, relay_url))
