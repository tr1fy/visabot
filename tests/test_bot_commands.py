from datetime import date, datetime

from run_loop import CheckResult
from vfsbot.bot_commands import BotState, format_status, handle_command, poll_commands


def test_start_sets_active_true():
    state = BotState(active=False)
    reply = handle_command("/start", state)
    assert state.active is True
    assert "started" in reply.lower()


def test_stop_sets_active_false():
    state = BotState(active=True)
    reply = handle_command("/stop", state)
    assert state.active is False
    assert "stopped" in reply.lower()


def test_start_with_group_bot_username_suffix():
    state = BotState(active=False)
    reply = handle_command("/start@vfsreg_bot", state)
    assert state.active is True
    assert "started" in reply.lower()


def test_status_with_group_bot_username_suffix():
    state = BotState(active=True)
    reply = handle_command("/status@vfsreg_bot", state)
    assert reply is not None
    assert "active" in reply.lower()


def test_scan_sets_scan_requested():
    state = BotState()
    reply = handle_command("/scan", state)
    assert state.scan_requested is True
    assert "scan" in reply.lower()


def test_status_reports_active_with_no_checks_yet():
    state = BotState(active=True)
    assert format_status(state) == "Status: 🟢 active\nNo checks run yet"


def test_status_reports_stopped():
    state = BotState(active=False)
    reply = handle_command("/status", state)
    assert "🔴 stopped" in reply


def test_status_includes_last_result_slot_found():
    state = BotState(
        active=True,
        last_result=CheckResult(
            timestamp=datetime(2026, 7, 11, 9, 30, 0), slot_date=date(2026, 7, 13)
        ),
    )
    reply = handle_command("/status", state)
    assert "slot found - 2026-07-13" in reply


def test_status_includes_last_result_error():
    state = BotState(
        active=True,
        last_result=CheckResult(
            timestamp=datetime(2026, 7, 11, 9, 30, 0), slot_date=None, error="login failed"
        ),
    )
    reply = handle_command("/status", state)
    assert "error - login failed" in reply


def test_unknown_command_returns_none():
    state = BotState()
    assert handle_command("/bogus", state) is None


def test_empty_text_returns_none():
    state = BotState()
    assert handle_command("", state) is None


def test_poll_commands_ignores_messages_from_other_chats():
    state = BotState()
    updates = [
        {
            "update_id": 1,
            "message": {"chat": {"id": 999}, "text": "/stop"},
        }
    ]
    calls = {"n": 0}

    def fake_get_updates(token, offset=None, timeout=30):
        calls["n"] += 1
        if calls["n"] == 1:
            return updates
        raise StopIteration

    sent = []

    def fake_send_message(token, chat_id, text):
        sent.append((chat_id, text))

    try:
        poll_commands(
            "TOKEN",
            "715697717",
            state,
            stop_fn=lambda: calls["n"] > 1,
            sleep_fn=lambda s: None,
            get_updates_fn=fake_get_updates,
            send_message_fn=fake_send_message,
        )
    except StopIteration:
        pass

    assert state.active is True
    assert sent == []


def test_poll_commands_applies_command_from_allowed_chat():
    state = BotState(active=True)
    updates = [
        {
            "update_id": 5,
            "message": {"chat": {"id": 715697717}, "text": "/stop"},
        }
    ]
    calls = {"n": 0}

    def fake_get_updates(token, offset=None, timeout=30):
        calls["n"] += 1
        if calls["n"] == 1:
            return updates
        return []

    sent = []

    def fake_send_message(token, chat_id, text):
        sent.append((chat_id, text))

    poll_commands(
        "TOKEN",
        "715697717",
        state,
        stop_fn=lambda: calls["n"] > 1,
        sleep_fn=lambda s: None,
        get_updates_fn=fake_get_updates,
        send_message_fn=fake_send_message,
    )

    assert state.active is False
    assert sent == [("715697717", "⏸️ Bot stopped. Scanning paused (still listening for commands).")]
