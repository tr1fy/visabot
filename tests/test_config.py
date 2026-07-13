# VFS-Bot-v2/tests/test_config.py
import pytest
from vfsbot.config import load_config, VfsConfig


def write_ini(tmp_path, contents):
    path = tmp_path / "config.ini"
    path.write_text(contents)
    return str(path)


def test_load_config_reads_all_fields(tmp_path):
    path = write_ini(tmp_path, """
[VFS]
email = user@example.com
password = secret123
centre = Italy Visa Application Center - Almaty
category = D Visa Study
sub_category = Enrollment at Universities
browser_backend = pydoll

[CHECK]
interval_minutes = 15

[TELEGRAM]
bot_token = 123456:ABCDEF
channel_id = -1001234567890
""")
    config = load_config(path)
    assert config == VfsConfig(
        email="user@example.com",
        password="secret123",
        centre="Italy Visa Application Center - Almaty",
        category="D Visa Study",
        sub_category="Enrollment at Universities",
        interval_minutes=15,
        telegram_bot_token="123456:ABCDEF",
        telegram_channel_id="-1001234567890",
        browser_backend="pydoll",
    )


def test_load_config_defaults_interval_when_missing(tmp_path):
    path = write_ini(tmp_path, """
[VFS]
email = user@example.com
password = secret123
centre = Italy Visa Application Center - Almaty
category = D Visa Study
sub_category = Enrollment at Universities

[CHECK]
""")
    config = load_config(path)
    assert config.interval_minutes == 20


def test_load_config_missing_file_raises(tmp_path):
    missing_path = str(tmp_path / "does_not_exist.ini")
    with pytest.raises(FileNotFoundError):
        load_config(missing_path)


def test_load_config_defaults_telegram_fields_when_section_missing(tmp_path):
    path = write_ini(tmp_path, """
[VFS]
email = user@example.com
password = secret123
centre = Italy Visa Application Center - Almaty
category = D Visa Study
sub_category = Enrollment at Universities

[CHECK]
interval_minutes = 15
""")
    config = load_config(path)
    assert config.telegram_bot_token == ""
    assert config.telegram_channel_id == ""


def test_load_config_defaults_browser_backend_to_pydoll(tmp_path):
    path = write_ini(tmp_path, """
[VFS]
email = user@example.com
password = secret123
centre = Italy Visa Application Center - Almaty
category = D Visa Study
sub_category = Enrollment at Universities

[CHECK]
interval_minutes = 15
""")
    config = load_config(path)
    assert config.browser_backend == "pydoll"


def test_load_config_reads_browser_backend_when_set(tmp_path):
    path = write_ini(tmp_path, """
[VFS]
email = user@example.com
password = secret123
centre = Italy Visa Application Center - Almaty
category = D Visa Study
sub_category = Enrollment at Universities
browser_backend = camoufox

[CHECK]
interval_minutes = 15
""")
    config = load_config(path)
    assert config.browser_backend == "camoufox"
