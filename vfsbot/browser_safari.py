# VFS-Bot-v2/vfsbot/browser_safari.py
#
# Drives the real, installed Safari.app via Selenium's safaridriver (Apple's
# native WebDriver, not Chrome DevTools Protocol). Unlike the pydoll and
# Camoufox backends, this one never attempts an automated login at all: it
# relies entirely on you having already logged into VFS manually in your own
# regular Safari window. Because safaridriver automates the same Safari.app
# installation (shared cookie store, not an isolated profile the way
# Chrome/Firefox profiles are), a WebDriver-controlled Safari window should
# already be authenticated once you've logged in normally.
#
# Requires (one-time, per Mac): Safari > Settings > Advanced > "Show Develop
# menu", then Develop > "Allow Remote Automation".

import asyncio

from selenium import webdriver
from selenium.webdriver.common.by import By

LOGIN_URL = "https://visa.vfsglobal.com/kaz/en/ita/login"
DASHBOARD_URL = "https://visa.vfsglobal.com/kaz/en/ita/dashboard"


class _AsyncSafariSession:
    """Wraps a synchronous Selenium WebDriver so every call site in this
    module can `await` it uniformly, matching the async interface the other
    backends (and checker.py's dispatch) expect. Selenium has no native
    async API; each blocking call is pushed to a worker thread."""

    def __init__(self, driver):
        self.driver = driver

    async def run(self, fn, *args, **kwargs):
        return await asyncio.to_thread(fn, *args, **kwargs)


class _AsyncBrowserContext:
    def __init__(self):
        self.session = None

    async def __aenter__(self):
        driver = await asyncio.to_thread(webdriver.Safari)
        await asyncio.to_thread(driver.set_window_size, 1280, 900)
        self.session = _AsyncSafariSession(driver)
        return self.session

    async def __aexit__(self, exc_type, exc, tb):
        await self.session.run(self.session.driver.quit)


def launch_browser():
    return _AsyncBrowserContext()


async def open_login_page(session) -> None:
    # Not used by the persistent-session flow below (login() navigates
    # straight to the dashboard instead) -- kept only for interface parity
    # with the other backends, in case a future caller wants it directly.
    await session.run(session.driver.get, LOGIN_URL)


async def login(session, email: str, password: str) -> None:
    # No automated form-fill, no Turnstile-solving: log in manually in your
    # own regular Safari window first. This just checks whether that
    # session is already valid.
    await session.run(session.driver.get, DASHBOARD_URL)
    await asyncio.sleep(3)
    url = await session.run(lambda: session.driver.current_url)
    if "dashboard" in url:
        return
    raise RuntimeError(
        "No valid VFS session found in Safari. Log in manually in a "
        "regular Safari window first (not this automated one), then "
        "re-run this check."
    )


def _find_visible_by_text(driver, tag: str, text: str):
    xpath = f"//{tag}[normalize-space(text())={_xpath_literal(text)}]"
    for el in driver.find_elements(By.XPATH, xpath):
        if el.is_displayed():
            return el
    return None


def _xpath_literal(text: str) -> str:
    if "'" not in text:
        return f"'{text}'"
    parts = text.split("'")
    return "concat(" + ", \"'\", ".join(f"'{p}'" for p in parts) + ")"


async def _wait_visible_by_text(session, tag: str, text: str, timeout_s: int = 20):
    driver = session.driver
    elapsed = 0
    while elapsed < timeout_s:
        el = await session.run(_find_visible_by_text, driver, tag, text)
        if el is not None:
            return el
        await asyncio.sleep(1)
        elapsed += 1
    raise RuntimeError(f"Timed out waiting for visible {tag} with text {text!r}")


async def select_application_details(
    session, centre: str, category: str, sub_category: str
) -> None:
    driver = session.driver

    start_btn = await _wait_visible_by_text(session, "button", "Start New Booking")
    await session.run(start_btn.click)

    elapsed = 0
    while elapsed < 20:
        url = await session.run(lambda: driver.current_url)
        if "dashboard" not in url:
            break
        await asyncio.sleep(1)
        elapsed += 1
    await asyncio.sleep(2)

    # Same Angular Material <mat-select> ordinal-position approach as the
    # other backends' select_application_details -- see browser_pydoll.py
    # for the full rationale (label text doesn't match, placeholder text
    # doesn't match, DOM order matches on-screen order).
    async def choose(select_index: int, option_text: str) -> None:
        def _get_visible_selects():
            return [
                el
                for el in driver.find_elements(By.TAG_NAME, "mat-select")
                if el.is_displayed()
            ]

        elapsed = 0
        selects = []
        while elapsed < 20:
            selects = await session.run(_get_visible_selects)
            if len(selects) > select_index:
                break
            await asyncio.sleep(1)
            elapsed += 1
        if len(selects) <= select_index:
            raise RuntimeError(
                f"Expected at least {select_index + 1} visible mat-select "
                f"dropdown(s), found {len(selects)}"
            )
        select_el = selects[select_index]
        current_text = (await session.run(lambda: select_el.text) or "").strip()
        if current_text == option_text:
            return  # already selected

        await session.run(select_el.click)
        await asyncio.sleep(1)

        option = await _wait_visible_by_text(session, "*", option_text)
        await session.run(option.click)
        await asyncio.sleep(1)

    await choose(0, centre)
    await choose(1, category)
    await choose(2, sub_category)
    await asyncio.sleep(2)


async def get_body_text(session) -> str:
    body = await session.run(session.driver.find_element, By.TAG_NAME, "body")
    return await session.run(lambda: body.text)
