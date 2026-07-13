# VFS-Bot-v2/login_setup.py
#
# One-time interactive setup: opens a visible Chrome window using the same
# persistent profile checker.py uses (vfsbot.browser_pydoll.PROFILE_DIR).
# Log in yourself in that window -- fill the form, solve the Turnstile
# checkbox, click Sign In -- exactly like a normal human visit. Once you
# reach the dashboard, this script detects it, confirms, and exits. The
# session cookies are saved in the profile directory by Chrome itself, so
# every later checker.py/run_loop.py run reuses this session instead of
# attempting an automated login.
#
# Run again whenever the session expires (checker.py will tell you with a
# clear error message if that happens).

import asyncio

from pydoll.browser import Chrome

from vfsbot.browser_pydoll import _build_options, dismiss_cookie_banner

LOGIN_URL = "https://visa.vfsglobal.com/kaz/en/ita/login"


async def main():
    options = _build_options()
    async with Chrome(options=options) as browser:
        tab = await browser.start()
        await tab.go_to(LOGIN_URL)
        await dismiss_cookie_banner(tab)

        print("Browser window open. Please log in manually now:")
        print("  1. Enter your email and password")
        print("  2. Solve the 'Verify you are human' checkbox")
        print("  3. Click Sign In")
        print("Waiting up to 5 minutes for you to reach the dashboard...")

        for i in range(60):
            await asyncio.sleep(5)
            url = await tab.current_url
            if "dashboard" in url:
                print(f"Success! Reached {url}")
                print("Session saved. You can now run checker.py or run_loop.py.")
                return
            await dismiss_cookie_banner(tab)

        print(
            "Timed out after 5 minutes without reaching the dashboard. "
            "Run this script again when you're ready."
        )


if __name__ == "__main__":
    asyncio.run(main())
