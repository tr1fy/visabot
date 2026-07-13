from typing import Optional

import requests


def send_message(bot_token: str, chat_id: str, text: str) -> None:
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    try:
        response = requests.post(
            url, json={"chat_id": chat_id, "text": text}, timeout=10
        )
        response.raise_for_status()
    except requests.RequestException as e:
        raise requests.RequestException(str(e).replace(bot_token, "<redacted>")) from None


def set_my_commands(bot_token: str, commands: list[tuple[str, str]]) -> None:
    url = f"https://api.telegram.org/bot{bot_token}/setMyCommands"
    payload = {"commands": [{"command": cmd, "description": desc} for cmd, desc in commands]}
    try:
        response = requests.post(url, json=payload, timeout=10)
        response.raise_for_status()
    except requests.RequestException as e:
        raise requests.RequestException(str(e).replace(bot_token, "<redacted>")) from None


def get_updates(bot_token: str, offset: Optional[int] = None, timeout: int = 30) -> list:
    url = f"https://api.telegram.org/bot{bot_token}/getUpdates"
    params = {"timeout": timeout}
    if offset is not None:
        params["offset"] = offset
    try:
        response = requests.get(url, params=params, timeout=timeout + 10)
        response.raise_for_status()
    except requests.RequestException as e:
        raise requests.RequestException(str(e).replace(bot_token, "<redacted>")) from None
    return response.json().get("result", [])
