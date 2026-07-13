# VFS-Bot-v2/run_loop.py
import time
from dataclasses import dataclass
from datetime import date, datetime
from typing import Callable, Optional


@dataclass
class CheckResult:
    timestamp: datetime
    slot_date: Optional[date]
    error: Optional[str] = None


def format_result_line(result: CheckResult) -> str:
    ts = result.timestamp.strftime("%Y-%m-%d %H:%M:%S")
    if result.error:
        return f"[{ts}] ERROR: {result.error}"
    if result.slot_date:
        return f"[{ts}] SLOT FOUND: {result.slot_date.isoformat()}"
    return f"[{ts}] no slots available"


def format_telegram_message(result: CheckResult) -> str:
    ts = result.timestamp.strftime("%Y-%m-%d %H:%M:%S")
    if result.error:
        return f"⚠️ Check failed: {result.error}"
    if result.slot_date:
        return f"✅ Slot available: {result.slot_date.isoformat()}"
    return f"No slots available (checked {ts})"


def _interruptible_sleep(total_seconds: float, sleep_fn: Callable[[float], None], state) -> None:
    if state is None:
        sleep_fn(total_seconds)
        return
    was_active = state.active
    elapsed = 0.0
    tick = 5.0
    while elapsed < total_seconds:
        if state.scan_requested or state.active != was_active:
            return
        step = min(tick, total_seconds - elapsed)
        sleep_fn(step)
        elapsed += step


def run_loop(
    check_fn: Callable[[], Optional[date]],
    interval_minutes: int,
    log_path: str,
    max_iterations: Optional[int] = None,
    sleep_fn: Callable[[float], None] = time.sleep,
    now_fn: Callable[[], datetime] = datetime.now,
    notify_fn: Optional[Callable[[CheckResult], None]] = None,
    state=None,
) -> list[CheckResult]:
    results: list[CheckResult] = []
    iteration = 0
    with open(log_path, "a") as log_file:
        while max_iterations is None or iteration < max_iterations:
            should_check = state is None or state.active or state.scan_requested
            if should_check:
                if state is not None:
                    state.scan_requested = False
                try:
                    slot_date = check_fn()
                    result = CheckResult(timestamp=now_fn(), slot_date=slot_date)
                except Exception as e:
                    result = CheckResult(timestamp=now_fn(), slot_date=None, error=str(e))
                results.append(result)
                log_file.write(format_result_line(result) + "\n")
                if state is not None:
                    state.last_result = result
                if notify_fn is not None:
                    try:
                        notify_fn(result)
                    except Exception as e:
                        ts = result.timestamp.strftime("%Y-%m-%d %H:%M:%S")
                        log_file.write(f"[{ts}] TELEGRAM SEND FAILED: {e}\n")
                log_file.flush()
            iteration += 1
            if max_iterations is None or iteration < max_iterations:
                _interruptible_sleep(interval_minutes * 60, sleep_fn, state)
    return results


if __name__ == "__main__":
    import threading

    from vfsbot.bot_commands import COMMANDS, BotState, poll_commands
    from vfsbot.config import load_config
    from vfsbot.telegram import send_message, set_my_commands
    from checker import run_check_sync

    cfg = load_config("config.ini")
    state = BotState()

    def _notify(result: CheckResult) -> None:
        send_message(
            cfg.telegram_bot_token,
            cfg.telegram_channel_id,
            format_telegram_message(result),
        )

    if cfg.telegram_bot_token and cfg.telegram_channel_id:
        set_my_commands(cfg.telegram_bot_token, COMMANDS)
        listener = threading.Thread(
            target=poll_commands,
            args=(cfg.telegram_bot_token, cfg.telegram_channel_id, state),
            daemon=True,
        )
        listener.start()
        send_message(
            cfg.telegram_bot_token,
            cfg.telegram_channel_id,
            "VFS-Bot запущен. Команды: /start /stop /scan /status",
        )

    run_loop(
        check_fn=lambda: run_check_sync(cfg),
        interval_minutes=cfg.interval_minutes,
        log_path="results.log",
        notify_fn=_notify,
        state=state,
    )
