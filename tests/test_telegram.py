from unittest.mock import patch, MagicMock
import pytest
from vfsbot.telegram import send_message, set_my_commands, get_updates


def test_send_message_posts_correct_url_and_payload():
    with patch("vfsbot.telegram.requests.post") as mock_post:
        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_post.return_value = mock_response

        send_message("TOKEN123", "-1001234567890", "hello world")

        mock_post.assert_called_once_with(
            "https://api.telegram.org/botTOKEN123/sendMessage",
            json={"chat_id": "-1001234567890", "text": "hello world"},
            timeout=10,
        )


def test_send_message_raises_on_non_2xx_response():
    with patch("vfsbot.telegram.requests.post") as mock_post:
        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = Exception("Bad Request")
        mock_post.return_value = mock_response

        with pytest.raises(Exception, match="Bad Request"):
            send_message("TOKEN123", "-1001234567890", "hello world")


def test_send_message_redacts_token_from_request_exception():
    import requests

    with patch("vfsbot.telegram.requests.post") as mock_post:
        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = requests.HTTPError(
            "400 Client Error: Bad Request for url: "
            "https://api.telegram.org/botTOKEN123/sendMessage"
        )
        mock_post.return_value = mock_response

        with pytest.raises(requests.RequestException) as exc_info:
            send_message("TOKEN123", "-1001234567890", "hello world")

        assert "TOKEN123" not in str(exc_info.value)
        assert "<redacted>" in str(exc_info.value)


def test_set_my_commands_posts_correct_url_and_payload():
    with patch("vfsbot.telegram.requests.post") as mock_post:
        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_post.return_value = mock_response

        set_my_commands("TOKEN123", [("start", "Resume scanning"), ("stop", "Pause scanning")])

        mock_post.assert_called_once_with(
            "https://api.telegram.org/botTOKEN123/setMyCommands",
            json={
                "commands": [
                    {"command": "start", "description": "Resume scanning"},
                    {"command": "stop", "description": "Pause scanning"},
                ]
            },
            timeout=10,
        )


def test_set_my_commands_redacts_token_from_request_exception():
    import requests

    with patch("vfsbot.telegram.requests.post") as mock_post:
        mock_response = MagicMock()
        mock_response.raise_for_status.side_effect = requests.HTTPError(
            "400 Client Error: Bad Request for url: "
            "https://api.telegram.org/botTOKEN123/setMyCommands"
        )
        mock_post.return_value = mock_response

        with pytest.raises(requests.RequestException) as exc_info:
            set_my_commands("TOKEN123", [("start", "Resume scanning")])

        assert "TOKEN123" not in str(exc_info.value)
        assert "<redacted>" in str(exc_info.value)


def test_get_updates_passes_offset_and_timeout():
    with patch("vfsbot.telegram.requests.get") as mock_get:
        mock_response = MagicMock()
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"result": [{"update_id": 1}]}
        mock_get.return_value = mock_response

        result = get_updates("TOKEN123", offset=5, timeout=30)

        mock_get.assert_called_once_with(
            "https://api.telegram.org/botTOKEN123/getUpdates",
            params={"timeout": 30, "offset": 5},
            timeout=40,
        )
        assert result == [{"update_id": 1}]
