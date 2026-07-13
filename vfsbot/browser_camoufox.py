# VFS-Bot-v2/vfsbot/browser_camoufox.py
import asyncio
from contextlib import asynccontextmanager

from camoufox.async_api import AsyncCamoufox

LOGIN_URL = "https://visa.vfsglobal.com/kaz/en/ita/login"


@asynccontextmanager
async def launch_browser():
    # headless=False mirrors the pydoll backend's requirement: the
    # Cloudflare Managed Challenge is known to detect headless Chrome, and
    # we have no live evidence yet of how Camoufox behaves headless against
    # this specific site, so start from the same known-safe posture.
    #
    # disable_coop=True is required for synthetic mouse clicks to actually
    # reach elements inside cross-origin iframes (e.g. the Turnstile
    # checkbox) -- without it, Cross-Origin-Opener-Policy isolation blocks
    # clicks from registering even at the correct coordinates (verified
    # directly: clicks at the visually-correct checkbox location did nothing
    # until this flag was added). humanize=True adds Bezier-curve cursor
    # movement, which Turnstile's behavioral checks may also expect.
    async with AsyncCamoufox(
        headless=False,
        disable_coop=True,
        humanize=True,
        i_know_what_im_doing=True,
    ) as browser:
        page = await browser.new_page()
        yield page


async def _click_turnstile_checkbox_if_visible(page) -> None:
    """Best-effort click on the Cloudflare Turnstile checkbox for the
    page-load Managed Challenge (before the login form has rendered).

    Unlike the login-form widget (see login()'s use of
    _click_login_turnstile_checkbox), there is no reliable on-page anchor
    element to compute a precise coordinate from at this point, and the
    widget's internals live in what appears to be a closed shadow root that
    neither frame_locator nor get_by_text can reach on Firefox (verified
    directly -- 0 matches for both). This is a best-effort no-op today;
    Camoufox's own stealth may avoid triggering the Managed Challenge
    entirely in most cases (see open_login_page's polling loop, which is
    the actual mechanism that matters here)."""
    pass


async def _click_login_turnstile_checkbox(page) -> None:
    """Click the Cloudflare Turnstile checkbox on the login form.

    The widget (including its own visible "Verify you are human" text)
    lives inside what appears to be a closed shadow root: no shadow host
    is detectable via el.shadowRoot, no CSS selector for Cloudflare/
    Turnstile-related classes matches, and page.get_by_text() finds 0
    matches for the widget's own visible text -- all verified directly.
    Playwright's standard locator engine cannot reach into it on Firefox
    the way pydoll could via Chrome's CDP-level shadow-root introspection.

    The only working approach found: a plain coordinate click at the
    checkbox's on-screen position, computed relative to the #password
    field (which is always present and positioned consistently above the
    widget), combined with disable_coop=True on browser launch (required
    for synthetic clicks to register on cross-origin iframe content at
    all -- without it, clicks at the correct coordinates were silently
    ignored, verified directly).
    """
    try:
        pw_box = await page.locator("#password").bounding_box()
        if not pw_box:
            return
        cx = pw_box["x"] + 10
        cy = pw_box["y"] + pw_box["height"] + 82
        await page.mouse.click(cx, cy)
    except Exception:
        pass


async def open_login_page(page) -> None:
    await page.goto(LOGIN_URL)

    # The Cloudflare Managed Challenge, if it appears, blocks the login
    # form (#email) from rendering. Poll for the form and try clicking any
    # visible challenge checkbox in the meantime, rather than assuming
    # Camoufox's stealth means it never appears.
    elapsed = 0
    while elapsed < 30:
        if await page.locator("#email").count() > 0:
            return
        await _click_turnstile_checkbox_if_visible(page)
        await asyncio.sleep(1)
        elapsed += 1

    raise RuntimeError(
        "Login form (#email) did not appear within timeout -- Cloudflare "
        "Managed Challenge may be blocking navigation"
    )


async def dismiss_cookie_banner(page) -> None:
    try:
        btn = page.get_by_text("Accept All Cookies")
        if await btn.is_visible(timeout=2000):
            await btn.click()
    except Exception:
        pass


async def _get_turnstile_token(page):
    return await page.evaluate(
        "() => { const el = document.querySelector("
        "'input[name=cf-turnstile-response]'); return el ? el.value : null; }"
    )


async def _wait_for_turnstile(page, timeout_s: int = 45) -> bool:
    """Same rationale as the pydoll backend's _wait_for_turnstile: the
    widget's visible "Success!" state can render before the actual
    verification token populates, so poll the real hidden input value
    rather than trusting on-screen text."""
    elapsed = 0
    while elapsed < timeout_s:
        token = await _get_turnstile_token(page)
        if token:
            return True
        await dismiss_cookie_banner(page)
        await _click_login_turnstile_checkbox(page)
        await asyncio.sleep(1)
        elapsed += 1
    return bool(await _get_turnstile_token(page))


async def login(page, email: str, password: str) -> None:
    await dismiss_cookie_banner(page)
    await page.wait_for_selector("#email", timeout=20000)
    await dismiss_cookie_banner(page)

    # Playwright's fill() replaces the field's value outright (unlike
    # pydoll's type_text(), which appends) -- the autofill-duplication bug
    # fixed in browser_pydoll.py's login() cannot occur here by construction.
    await page.fill("#email", email)
    await page.fill("#password", password)
    await asyncio.sleep(1)
    await dismiss_cookie_banner(page)

    turnstile_solved = await _wait_for_turnstile(page)
    if not turnstile_solved:
        raise RuntimeError(
            "Turnstile did not solve within the timeout; aborting before "
            "Sign In to avoid the site's misleading 'not registered' "
            "fallback message for missing/invalid captcha tokens"
        )
    await asyncio.sleep(1)

    await page.get_by_text("Sign In", exact=True).click()
    await asyncio.sleep(6)

    if "dashboard" not in page.url:
        raise RuntimeError(f"Login did not reach dashboard, ended at {page.url}")


async def select_application_details(
    page, centre: str, category: str, sub_category: str
) -> None:
    await page.get_by_text("Start New Booking").click()

    elapsed = 0
    while elapsed < 20 and "dashboard" in page.url:
        await asyncio.sleep(1)
        elapsed += 1
    await asyncio.sleep(2)

    # Same dropdown structure/ordering rationale as browser_pydoll.py's
    # select_application_details: three Angular Material <mat-select>
    # comboboxes in on-screen top-to-bottom DOM order (centre, category,
    # sub-category). Playwright's ":visible" pseudo-class filters out any
    # hidden duplicate nodes before indexing by ordinal position, achieving
    # the same effect as the pydoll backend's manual is_visible() filter.
    async def choose(select_index: int, option_text: str) -> None:
        select_el = page.locator("mat-select:visible").nth(select_index)
        current_text = (await select_el.inner_text()).strip()
        if current_text == option_text:
            return  # already selected
        await select_el.click()
        await asyncio.sleep(1)
        await page.get_by_text(option_text, exact=True).click()
        await asyncio.sleep(1)

    await choose(0, centre)
    await choose(1, category)
    await choose(2, sub_category)
    await asyncio.sleep(2)


async def get_body_text(page) -> str:
    return await page.inner_text("body")
