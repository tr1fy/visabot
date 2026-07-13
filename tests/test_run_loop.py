from datetime import date, datetime
from run_loop import CheckResult, format_result_line, run_loop


def test_format_result_line_with_slot():
    result = CheckResult(
        timestamp=datetime(2026, 7, 11, 9, 30, 0), slot_date=date(2026, 7, 13)
    )
    assert format_result_line(result) == "[2026-07-11 09:30:00] SLOT FOUND: 2026-07-13"


def test_format_result_line_no_slot():
    result = CheckResult(timestamp=datetime(2026, 7, 11, 9, 30, 0), slot_date=None)
    assert format_result_line(result) == "[2026-07-11 09:30:00] no slots available"


def test_format_result_line_error():
    result = CheckResult(
        timestamp=datetime(2026, 7, 11, 9, 30, 0), slot_date=None, error="login failed"
    )
    assert format_result_line(result) == "[2026-07-11 09:30:00] ERROR: login failed"


def test_run_loop_calls_check_fn_max_iterations_times(tmp_path):
    calls = []

    def fake_check():
        calls.append(1)
        return date(2026, 7, 13) if len(calls) == 2 else None

    sleeps = []
    log_path = str(tmp_path / "results.log")

    results = run_loop(
        check_fn=fake_check,
        interval_minutes=5,
        log_path=log_path,
        max_iterations=3,
        sleep_fn=lambda seconds: sleeps.append(seconds),
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
    )

    assert len(calls) == 3
    assert [r.slot_date for r in results] == [None, date(2026, 7, 13), None]
    # sleeps between iterations only: 2 sleeps for 3 iterations
    assert sleeps == [300, 300]


def test_run_loop_writes_log_lines(tmp_path):
    log_path = str(tmp_path / "results.log")
    run_loop(
        check_fn=lambda: None,
        interval_minutes=1,
        log_path=log_path,
        max_iterations=2,
        sleep_fn=lambda seconds: None,
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
    )
    lines = open(log_path).read().strip().split("\n")
    assert len(lines) == 2
    assert lines[0] == "[2026-07-11 09:30:00] no slots available"


def test_run_loop_catches_check_fn_exceptions(tmp_path):
    log_path = str(tmp_path / "results.log")

    def failing_check():
        raise RuntimeError("login failed")

    results = run_loop(
        check_fn=failing_check,
        interval_minutes=1,
        log_path=log_path,
        max_iterations=1,
        sleep_fn=lambda seconds: None,
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
    )
    assert results[0].error == "login failed"
    assert results[0].slot_date is None


def test_format_telegram_message_with_slot():
    from run_loop import format_telegram_message

    result = CheckResult(
        timestamp=datetime(2026, 7, 11, 9, 30, 0), slot_date=date(2026, 7, 13)
    )
    assert format_telegram_message(result) == "✅ Slot available: 2026-07-13"


def test_format_telegram_message_no_slot():
    from run_loop import format_telegram_message

    result = CheckResult(timestamp=datetime(2026, 7, 11, 9, 30, 0), slot_date=None)
    assert (
        format_telegram_message(result)
        == "No slots available (checked 2026-07-11 09:30:00)"
    )


def test_format_telegram_message_error():
    from run_loop import format_telegram_message

    result = CheckResult(
        timestamp=datetime(2026, 7, 11, 9, 30, 0), slot_date=None, error="login failed"
    )
    assert format_telegram_message(result) == "⚠️ Check failed: login failed"


def test_run_loop_calls_notify_fn_once_per_iteration(tmp_path):
    notified = []
    log_path = str(tmp_path / "results.log")

    run_loop(
        check_fn=lambda: date(2026, 7, 13),
        interval_minutes=1,
        log_path=log_path,
        max_iterations=2,
        sleep_fn=lambda seconds: None,
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
        notify_fn=lambda result: notified.append(result),
    )

    assert len(notified) == 2
    assert notified[0].slot_date == date(2026, 7, 13)


def test_run_loop_survives_notify_fn_failure(tmp_path):
    log_path = str(tmp_path / "results.log")

    def failing_notify(result):
        raise RuntimeError("telegram unreachable")

    results = run_loop(
        check_fn=lambda: None,
        interval_minutes=1,
        log_path=log_path,
        max_iterations=1,
        sleep_fn=lambda seconds: None,
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
        notify_fn=failing_notify,
    )

    assert len(results) == 1
    assert results[0].error is None  # notify failure doesn't corrupt the check result

    lines = open(log_path).read().strip().split("\n")
    assert len(lines) == 2
    assert lines[0] == "[2026-07-11 09:30:00] no slots available"
    assert lines[1] == "[2026-07-11 09:30:00] TELEGRAM SEND FAILED: telegram unreachable"


def test_run_loop_skips_check_when_state_inactive(tmp_path):
    from vfsbot.bot_commands import BotState

    calls = []
    state = BotState(active=False)
    log_path = str(tmp_path / "results.log")

    results = run_loop(
        check_fn=lambda: calls.append(1),
        interval_minutes=1,
        log_path=log_path,
        max_iterations=3,
        sleep_fn=lambda seconds: None,
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
        state=state,
    )

    assert calls == []
    assert results == []


def test_run_loop_forces_scan_when_scan_requested_while_inactive(tmp_path):
    from vfsbot.bot_commands import BotState

    calls = []
    state = BotState(active=False, scan_requested=True)
    log_path = str(tmp_path / "results.log")

    results = run_loop(
        check_fn=lambda: calls.append(1) or None,
        interval_minutes=1,
        log_path=log_path,
        max_iterations=1,
        sleep_fn=lambda seconds: None,
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
        state=state,
    )

    assert len(calls) == 1
    assert len(results) == 1
    assert state.scan_requested is False


def test_run_loop_sleeps_full_interval_while_active_and_no_scan_requested(tmp_path):
    from vfsbot.bot_commands import BotState

    state = BotState(active=True)
    sleeps = []
    log_path = str(tmp_path / "results.log")

    run_loop(
        check_fn=lambda: None,
        interval_minutes=1,
        log_path=log_path,
        max_iterations=2,
        sleep_fn=lambda seconds: sleeps.append(seconds),
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
        state=state,
    )

    # steady-state active loop must still wait out the full interval between
    # checks (in 5s ticks), not return immediately just because state.active
    # is truthy
    assert sum(sleeps) == 60


def test_run_loop_wakes_early_when_scan_requested_mid_sleep(tmp_path):
    from vfsbot.bot_commands import BotState

    state = BotState(active=True)
    sleeps = []
    log_path = str(tmp_path / "results.log")

    def fake_sleep(seconds):
        sleeps.append(seconds)
        if len(sleeps) == 2:
            state.scan_requested = True

    run_loop(
        check_fn=lambda: None,
        interval_minutes=1,
        log_path=log_path,
        max_iterations=2,
        sleep_fn=fake_sleep,
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
        state=state,
    )

    assert sum(sleeps) < 60


def test_run_loop_updates_state_last_result(tmp_path):
    from vfsbot.bot_commands import BotState

    state = BotState(active=True)
    log_path = str(tmp_path / "results.log")

    run_loop(
        check_fn=lambda: date(2026, 7, 13),
        interval_minutes=1,
        log_path=log_path,
        max_iterations=1,
        sleep_fn=lambda seconds: None,
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
        state=state,
    )

    assert state.last_result.slot_date == date(2026, 7, 13)


def test_run_loop_without_notify_fn_still_works(tmp_path):
    log_path = str(tmp_path / "results.log")

    results = run_loop(
        check_fn=lambda: None,
        interval_minutes=1,
        log_path=log_path,
        max_iterations=1,
        sleep_fn=lambda seconds: None,
        now_fn=lambda: datetime(2026, 7, 11, 9, 30, 0),
    )

    assert len(results) == 1
    lines = open(log_path).read().strip().split("\n")
    assert len(lines) == 1
