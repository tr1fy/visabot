# VFS-Bot-v2/checker.py
import asyncio
from datetime import date
from typing import Optional

from vfsbot.config import VfsConfig
from vfsbot.slot_parser import parse_earliest_slot


def _get_backend(name: str):
    if name == "camoufox":
        from vfsbot import browser_camoufox as backend
    elif name == "safari":
        from vfsbot import browser_safari as backend
    else:
        from vfsbot import browser_pydoll as backend
    return backend


async def run_check(config: VfsConfig) -> Optional[date]:
    backend = _get_backend(config.browser_backend)
    async with backend.launch_browser() as session:
        await backend.open_login_page(session)
        await backend.login(session, config.email, config.password)
        await backend.select_application_details(
            session, config.centre, config.category, config.sub_category
        )
        body_text = await backend.get_body_text(session)
        return parse_earliest_slot(body_text)


def run_check_sync(config: VfsConfig) -> Optional[date]:
    return asyncio.run(run_check(config))


if __name__ == "__main__":
    from vfsbot.config import load_config

    cfg = load_config("config.ini")
    result = run_check_sync(cfg)
    if result:
        print(f"Slot available: {result.isoformat()}")
    else:
        print("No slots available")
