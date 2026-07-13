# VFS-Bot-v2/vfsbot/browser_pydoll.py
import asyncio
import time
from contextlib import asynccontextmanager
from pathlib import Path

from pydoll.browser import Chrome
from pydoll.browser.options import ChromiumOptions
from pydoll.commands import PageCommands


def _unwrap_script_result(result, *, strict: bool = False):
    """Unwrap the nested dict shape pydoll's execute_script() returns
    (`result["result"]["result"]["value"]`) for the three call sites that
    all expect it.

    Non-dict results (e.g. plain values already unwrapped by the driver)
    are returned as-is.

    If `result` is a dict but doesn't have the expected shape:
      - strict=False (the default, used by callers that treat "couldn't
        read it" the same as "value not present yet", e.g. polling for a
        token that hasn't populated): returns None.
      - strict=True (used by get_body_text, where a broken read must not
        be confused with a genuinely empty page): raises RuntimeError
        describing the unexpected shape, so callers upstream see a clear
        error instead of silently treating a broken read as "no slots".
    """
    if not isinstance(result, dict):
        return result
    try:
        return result["result"]["result"]["value"]
    except (KeyError, TypeError) as exc:
        if strict:
            raise RuntimeError(
                f"Unexpected execute_script() result shape, could not unwrap "
                f"value: {result!r}"
            ) from exc
        return None


async def _apply_regional_consistency(tab) -> None:
    """Make the automated profile's declared timezone/geolocation agree with
    the Kazakhstan mission this checker targets (Asia/Almaty, UTC+5), rather
    than leaving them at whatever the host machine's real locale is. A visa
    site risk-scoring a Kazakhstan applicant is a plausible signal to keep
    consistent; this is a low-cost, low-risk hardening applied before every
    navigation to the login page, not a guaranteed fix for VFS's fraud
    detection (which is known to be actively maintained against automation
    tools -- see e.g. the abandoned autoscrape/vfsauto project, whose author
    reported VFS added outright account bans in response)."""
    tz_script = """
        const _origDTF = Intl.DateTimeFormat;
        Intl.DateTimeFormat = function(...args) {
            const opts = args[1] || {};
            opts.timeZone = 'Asia/Almaty';
            return new _origDTF(args[0], opts);
        };
        Date.prototype.getTimezoneOffset = function() { return -300; };
    """
    await tab._execute_command(
        PageCommands.add_script_to_evaluate_on_new_document(
            source=tz_script, run_immediately=True
        )
    )

    geo_script = """
        navigator.geolocation.getCurrentPosition = function(success) {
            success({
                coords: { latitude: 43.2389, longitude: 76.8897, accuracy: 50 },
                timestamp: Date.now()
            });
        };
    """
    await tab._execute_command(
        PageCommands.add_script_to_evaluate_on_new_document(
            source=geo_script, run_immediately=True
        )
    )


async def open_login_page(tab) -> None:
    await _apply_regional_consistency(tab)
    url = "https://visa.vfsglobal.com/kaz/en/ita/login"
    try:
        async with tab.expect_and_bypass_cloudflare_captcha():
            await tab.go_to(url)
    except Exception:
        # Managed Challenge may already be resolved by the time we check;
        # if navigation actually failed we'll still be on about:blank/new-tab.
        if await tab.current_url in ("chrome://new-tab-page/", "about:blank"):
            await tab.go_to(url)

    for _ in range(5):
        await asyncio.sleep(3)
        if await tab.title:
            break


async def dismiss_cookie_banner(tab) -> None:
    for _ in range(5):
        cookie_btn = await tab.find(text="Accept All Cookies", raise_exc=False)
        if not cookie_btn or not await cookie_btn.is_visible():
            return
        await cookie_btn.click()
        await asyncio.sleep(1)
        still_visible = await tab.find(text="Accept All Cookies", raise_exc=False)
        if still_visible and await still_visible.is_visible():
            await tab.execute_script(
                "document.evaluate(\"//button[contains(text(),'Accept All Cookies')]\","
                "document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null)"
                ".singleNodeValue?.click()"
            )
            await asyncio.sleep(1)


async def _find_all_matches(tab, **find_kwargs):
    """tab.find(...) (singular) returns the *first* DOM match for a given
    selector, which on this site is sometimes a hidden duplicate (e.g. a
    second, invisible copy of a button/label used for a mobile layout or a
    skeleton-loading placeholder) rather than the on-screen element a user
    would actually click. Always search all matches so callers can filter
    for the one that's genuinely visible."""
    found = await tab.find(find_all=True, raise_exc=False, **find_kwargs)
    return found or []


async def _wait_for_element(tab, timeout_s: int = 20, **find_kwargs):
    """Poll until an element matching find_kwargs appears and is visible
    (SPA content can render well after document.title / navigation settle,
    and the first DOM match for text/label selectors is sometimes a hidden
    duplicate -- see _find_all_matches)."""
    elapsed = 0
    while elapsed < timeout_s:
        for el in await _find_all_matches(tab, **find_kwargs):
            try:
                if await el.is_visible():
                    return el
            except Exception:
                continue
        await asyncio.sleep(1)
        elapsed += 1
    raise RuntimeError(f"Timed out waiting for element: {find_kwargs}")


async def _wait_clickable(tab, timeout_s: int = 20, **find_kwargs):
    """Poll for an element that is present, visible, and not covered by a
    transient overlay (e.g. a post-navigation loading spinner) or shadowed
    by a hidden duplicate match (see _find_all_matches).

    Re-fetches all matching elements fresh on every poll rather than reusing
    a single reference, since the button under a loading overlay is often
    re-rendered (React swaps the disabled/enabled version in) once the
    overlay clears -- a stale reference could report is_on_top() against a
    detached node.
    """
    elapsed = 0
    while elapsed < timeout_s:
        for el in await _find_all_matches(tab, **find_kwargs):
            try:
                if await el.is_visible() and await el.is_on_top():
                    return el
            except Exception:
                continue
        await asyncio.sleep(1)
        elapsed += 1
    raise RuntimeError(f"Timed out waiting for clickable element: {find_kwargs}")


async def _find_turnstile_iframe(tab):
    """Locate the Cloudflare Turnstile widget's <iframe> on the login form.

    The widget lives inside a shadow root on the host page whose innerHTML
    references challenges.cloudflare.com. Returns None if no such widget is
    present (e.g. it hasn't mounted yet).
    """
    shadow_roots = await tab.find_shadow_roots(deep=False)
    for sr in shadow_roots:
        html = await sr.inner_html
        if "challenges.cloudflare.com" not in html:
            continue
        try:
            return await sr.query("iframe", timeout=3)
        except Exception:
            continue
    return None


async def _get_turnstile_token(tab):
    result = await tab.execute_script(
        "const el = document.querySelector('input[name=cf-turnstile-response]');"
        "return el ? el.value : null;"
    )
    return _unwrap_script_result(result)


async def _wait_for_turnstile(tab, timeout_s: int = 45) -> bool:
    """Wait for the Cloudflare Turnstile widget on the login form to solve.

    The widget's on-screen "Success!" / green-checkmark state (found by
    crawling into its nested shadow DOM) can render as static markup before
    the actual verification token (input[name=cf-turnstile-response]) is
    populated, so text/DOM presence alone is not a trustworthy signal — the
    hidden response token is what the backend actually checks on submit. We
    poll for that token directly.

    Some widget instances resolve invisibly within a second; others need an
    explicit click. Rather than trying to reach into the (closed, often
    cross-origin) shadow DOM to find the checkbox precisely, we click at the
    center of the widget's own bounding box every few seconds — the same
    coordinate a human would click — which works regardless of how deep the
    checkbox is nested.
    """
    elapsed = 0
    last_click = -3
    while elapsed < timeout_s:
        token = await _get_turnstile_token(tab)
        if token:
            return True

        # Cookie-banner reappearance or overlays can block the widget;
        # keep it clear while we wait.
        await dismiss_cookie_banner(tab)

        if elapsed - last_click >= 3:
            iframe = await _find_turnstile_iframe(tab)
            if iframe is not None:
                try:
                    if await iframe.is_visible():
                        quad = await iframe.bounds
                        cx = sum(quad[0::2]) / 4
                        cy = sum(quad[1::2]) / 4
                        await tab.mouse.click(cx, cy)
                except Exception:
                    pass
            last_click = elapsed

        await asyncio.sleep(1)
        elapsed += 1

    return bool(await _get_turnstile_token(tab))


async def login(tab, email: str, password: str) -> None:
    # If launch_browser()'s persistent profile (see PROFILE_DIR) already
    # holds a valid session -- established by a human running
    # login_setup.py manually -- reuse it instead of attempting an
    # automated login POST. VFS's anti-bot detection appears to distrust
    # the automated login step specifically (a real, Safari-confirmed
    # account still got a misleading "not registered" response when this
    # code submitted the login form, even with Turnstile genuinely solved),
    # so skipping that step entirely when possible is the point -- this is
    # not a fallback to try automation first and reuse session as backup,
    # it's the reverse: prefer the existing session, and fail loudly with
    # clear setup instructions if there isn't one, rather than silently
    # falling through to the unreliable automated form-fill path.
    dashboard_url = "https://visa.vfsglobal.com/kaz/en/ita/dashboard"
    await tab.go_to(dashboard_url)
    await asyncio.sleep(3)
    if "dashboard" in await tab.current_url:
        return

    raise RuntimeError(
        "No valid VFS session found in the persistent Chrome profile "
        f"({PROFILE_DIR}). Run login_setup.py once to log in manually in "
        "the browser window it opens, then re-run this check."
    )


async def _automated_login(tab, email: str, password: str) -> None:
    """The original automated login flow (fill form, solve Turnstile,
    click Sign In). Kept for login_setup.py's optional use and for
    reference, but login() itself no longer calls this automatically --
    see login()'s docstring/comment for why."""
    await dismiss_cookie_banner(tab)

    # Wait for the SPA to render the login form (title/navigation settle
    # well before the React form mounts).
    await _wait_for_element(tab, id="email")

    # Dismissing the cookie banner can cause the form to re-render, which
    # detaches any WebElement references fetched before the dismissal.
    # Dismiss first, then fetch the email/password elements fresh so we
    # never type into a stale/detached node.
    await dismiss_cookie_banner(tab)
    await asyncio.sleep(0.5)

    email_input = await _wait_for_element(tab, id="email")
    password_input = await tab.find(id="password")

    # Chrome's form autofill can pre-populate these fields from a saved
    # credential (this profile has logged into this exact site before), and
    # type_text() appends rather than replaces — the observed symptom was a
    # doubled-up value like "mrripr2@gmail.commrripr2@gmail.com" that fails
    # the site's email-format validation and leaves Sign In disabled even
    # though Turnstile shows "Success!". Clear defensively before typing.
    await email_input.click()
    await email_input.clear()
    await email_input.type_text(email, humanize=True)
    await password_input.click()
    await password_input.clear()
    await password_input.type_text(password, humanize=True)
    await asyncio.sleep(1)

    # Belt-and-suspenders: verify the value actually settled as typed (not
    # empty, not duplicated by a stray autofill re-application) and retry
    # once if not.
    async def _current_value(el) -> str:
        result = await el.execute_script("return this.value", return_by_value=True)
        return _unwrap_script_result(result) or ""

    if await _current_value(email_input) != email:
        await email_input.click()
        await email_input.clear()
        await email_input.type_text(email, humanize=True)
        await asyncio.sleep(0.5)

    if await _current_value(password_input) != password:
        await password_input.click()
        await password_input.clear()
        await password_input.type_text(password, humanize=True)
        await asyncio.sleep(0.5)

    await asyncio.sleep(1)

    await dismiss_cookie_banner(tab)

    # See _wait_for_turnstile for why we poll the actual response token
    # instead of relying on expect_and_bypass_cloudflare_captcha(), which
    # is driven by a page-level LOAD_EVENT_FIRED callback that does not
    # fire again after the initial page load (no navigation happens here).
    #
    # If the Turnstile token never populates, the site does not reject the
    # submission with a captcha-specific error — it silently falls back to
    # a generic "email id is not registered" message regardless of the
    # actual account state, which is misleading if we click Sign In anyway.
    # Fail loudly here instead of walking into that red herring.
    turnstile_solved = await _wait_for_turnstile(tab)
    if not turnstile_solved:
        raise RuntimeError(
            "Turnstile did not solve within the timeout; aborting before "
            "Sign In to avoid the site's misleading 'not registered' "
            "fallback message for missing/invalid captcha tokens"
        )
    await asyncio.sleep(1)

    # tab.find(tag_name="button", text="Sign In") (singular) risks matching a
    # hidden duplicate node -- the same class of bug already fixed for the
    # "Start New Booking" button -- which would silently no-op the click and
    # leave the page showing whatever stale state it was already in (observed
    # as the site's misleading "not registered" banner surviving a click that
    # never actually landed on the real button). Use the same visible+on-top
    # filtering as the rest of this file's clickable lookups.
    #
    # Combining tag_name and text in one find_all lookup returns zero matches
    # on this pydoll version even when a matching element genuinely exists
    # (verified directly) -- every other clickable lookup in this file
    # (e.g. "Start New Booking", dropdown options) already avoids this by
    # passing text alone, so do the same here rather than tag_name+text.
    signin_btn = await _wait_clickable(tab, text="Sign In")

    try:
        await signin_btn.click()
    except Exception:
        await tab.execute_script(
            "document.evaluate(\"//button[normalize-space(text())='Sign In']\","
            "document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null)"
            ".singleNodeValue?.click()"
        )
    await asyncio.sleep(6)

    if "dashboard" not in await tab.current_url:
        raise RuntimeError(
            f"Login did not reach dashboard, ended at {await tab.current_url}"
        )


async def select_application_details(
    tab, centre: str, category: str, sub_category: str
) -> None:
    # Right after login, the dashboard renders behind a loading overlay/
    # spinner for a couple of seconds; clicking the button while it's
    # covered raises pydoll's ElementNotVisible. Wait until it's genuinely
    # on top before clicking.
    start_btn = await _wait_clickable(tab, text="Start New Booking")
    try:
        await start_btn.click()
    except Exception:
        await tab.execute_script(
            "document.evaluate(\"//button[contains(text(),'Start New Booking')]\","
            "document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null)"
            ".singleNodeValue?.click()"
        )

    # Wait for actual navigation away from the dashboard rather than a
    # fixed sleep.
    elapsed = 0
    while elapsed < 20 and "dashboard" in await tab.current_url:
        await asyncio.sleep(1)
        elapsed += 1
    await asyncio.sleep(2)

    # These dropdowns are Angular Material <mat-select> comboboxes, not
    # native <select> elements, and not plain clickable text either:
    #   - The field label ("Choose your Application Centre*") is a separate
    #     DOM node from its required-field asterisk, so no element's text
    #     content ever equals the label string verbatim (0 matches).
    #   - Each <mat-select>'s own visible text is its *placeholder*
    #     ("Choose your Application Centre", "Select your appointment
    #     category", "Select your sub-category") which does not consistently
    #     match its label text, so the label can't be used to find the
    #     control to click either.
    #   - <mat-select>'s DOM order (via querySelectorAll) matches the
    #     on-screen top-to-bottom order (centre, category, sub-category)
    #     even though Angular's internal id numbering
    #     (mat-select-0/1/2) does not.
    # So we select each dropdown by its ordinal position among all
    # <mat-select role="combobox"> elements on the page, then click the
    # matching option text in the overlay panel that opens.
    async def choose(select_index: int, option_text: str) -> None:
        all_selects = await tab.find(tag_name="mat-select", find_all=True)

        # Filter to genuinely visible elements before indexing by ordinal
        # position -- this site has hidden duplicate DOM nodes elsewhere
        # (see _find_all_matches / Bug 2's "Start New Booking" fix) that
        # would otherwise silently shift which on-screen dropdown a given
        # ordinal index resolves to.
        selects = []
        for el in all_selects:
            try:
                if await el.is_visible():
                    selects.append(el)
            except Exception:
                continue

        if len(selects) <= select_index:
            raise RuntimeError(
                f"Expected at least {select_index + 1} visible mat-select "
                f"dropdown(s) on the application details page, found "
                f"{len(selects)} (out of {len(all_selects)} total mat-select "
                f"elements in the DOM)"
            )
        select_el = selects[select_index]

        current_text = (await select_el.text or "").strip()
        if current_text == option_text:
            return  # already selected

        try:
            await select_el.click()
        except Exception:
            await select_el.click_using_js()
        await asyncio.sleep(1)

        option = await _wait_clickable(tab, text=option_text)
        try:
            await option.click()
        except Exception:
            await option.click_using_js()
        await asyncio.sleep(1)

    await choose(0, centre)
    await choose(1, category)
    await choose(2, sub_category)
    await asyncio.sleep(2)


async def get_body_text(tab) -> str:
    result = await tab.execute_script("return document.body.innerText")
    # strict=True: a broken/unexpected result shape here must surface as a
    # visible error (propagating up through checker.run_check -> run_loop's
    # ERROR logging), not silently fall back to a stringified dict that
    # parse_earliest_slot would misread as "no slots available".
    value = _unwrap_script_result(result, strict=True)
    return str(value)


# A persistent Chrome profile directory (gitignored), rather than a fresh
# temp dir per run. This is what makes session reuse possible at all: a
# human logs in manually once via login_setup.py using this exact profile,
# and every later checker.py run reuses its cookies instead of attempting
# an automated login POST -- the thing VFS's anti-bot detection actually
# seems to distrust, independent of whether Turnstile itself is solved.
PROFILE_DIR = str(Path(__file__).resolve().parent.parent / "chrome_profile")


def _build_options() -> ChromiumOptions:
    options = ChromiumOptions()
    options.headless = False  # Cloudflare Managed Challenge requires a visible browser

    # An aged profile (90 days, not 7) reads as a real returning user rather
    # than a freshly-spun-up automation profile -- per pydoll's own fingerprint
    # evasion guidance, a too-fresh profile is itself a signal.
    now = time.time()
    aged_creation_time = now - (90 * 24 * 60 * 60)
    fake_engagement_time = now - (7 * 24 * 60 * 60)
    options.browser_preferences = {
        "profile": {
            "created_by_version": "150.0.7871.49",
            "creation_time": str(aged_creation_time),
            "last_engagement_time": fake_engagement_time,
            "exit_type": "Normal",
            "exited_cleanly": True,
            "default_content_setting_values": {
                "notifications": 2,
                "geolocation": 2,
            },
            "password_manager_enabled": False,
        },
        # NOTE: a Kazakhstan-region Accept-Language (e.g. Russian-first) would
        # be more regionally consistent, but every element lookup in this file
        # (button/link text like "Sign In", "Start New Booking", the
        # configured centre/category/sub_category strings) is hardcoded to
        # the English UI text this site renders under "en-US,en". Changing
        # this without also making those lookups locale-aware would break
        # the automation outright, so English is kept here deliberately --
        # this is a known, unresolved tension between regional consistency
        # and the current text-based selectors.
        "intl": {"accept_languages": "en-US,en"},
    }
    options.webrtc_leak_protection = True
    options.add_argument("--window-size=1920,1080")
    options.add_argument(f"--user-data-dir={PROFILE_DIR}")
    options.start_timeout = 30
    return options


@asynccontextmanager
async def launch_browser():
    options = _build_options()
    async with Chrome(options=options) as browser:
        tab = await browser.start()
        yield tab
