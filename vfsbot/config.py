# VFS-Bot-v2/vfsbot/config.py
import configparser
from dataclasses import dataclass


@dataclass
class VfsConfig:
    email: str
    password: str
    centre: str
    category: str
    sub_category: str
    interval_minutes: int
    telegram_bot_token: str = ""
    telegram_channel_id: str = ""
    browser_backend: str = "pydoll"
    proxy_url: str = ""


def load_config(path: str) -> VfsConfig:
    parser = configparser.ConfigParser()
    read_files = parser.read(path)
    if not read_files:
        raise FileNotFoundError(f"Config file not found: {path}")

    vfs = parser["VFS"]
    check = parser["CHECK"] if parser.has_section("CHECK") else {}
    telegram = parser["TELEGRAM"] if parser.has_section("TELEGRAM") else {}

    return VfsConfig(
        email=vfs.get("email", "").strip(),
        password=vfs.get("password", "").strip(),
        centre=vfs.get("centre", "").strip(),
        category=vfs.get("category", "").strip(),
        sub_category=vfs.get("sub_category", "").strip(),
        interval_minutes=int(check.get("interval_minutes", "20")),
        telegram_bot_token=telegram.get("bot_token", "").strip(),
        telegram_channel_id=telegram.get("channel_id", "").strip(),
        browser_backend=vfs.get("browser_backend", "pydoll").strip(),
    )
