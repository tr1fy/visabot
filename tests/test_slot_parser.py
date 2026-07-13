from datetime import date
from vfsbot.slot_parser import parse_earliest_slot


def test_parses_earliest_slot_banner():
    text = "Earliest available slot for 1,2,3 Applicants is : 13-07-2026"
    assert parse_earliest_slot(text) == date(2026, 7, 13)


def test_parses_banner_embedded_in_larger_page_text():
    text = (
        "Appointment Details\n"
        "Choose your Application Centre*\n"
        "Italy Visa Application Center - Almaty\n"
        "Earliest available slot for 1,2,3 Applicants is : 13-07-2026\n"
        "Continue"
    )
    assert parse_earliest_slot(text) == date(2026, 7, 13)


def test_returns_none_when_banner_absent():
    text = "Appointment Details\nChoose your Application Centre*\nContinue"
    assert parse_earliest_slot(text) is None


def test_returns_none_for_empty_string():
    assert parse_earliest_slot("") is None
