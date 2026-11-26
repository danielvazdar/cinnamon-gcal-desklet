import os
import sys
from datetime import date

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gcal-month-week@osobno"))
import fetch

CALENDAR_COLOR = "#039be5"


@pytest.fixture(autouse=True)
def zagreb_time(monkeypatch):
    monkeypatch.setenv("TZ", "Europe/Zagreb")
    import time
    time.tzset()


def test_all_day_event_end_date_becomes_inclusive():
    item = fetch.normalise_event({"summary": "Trip", "start": {"date": "2026-11-20"},
                                  "end": {"date": "2026-11-23"}}, CALENDAR_COLOR)
    assert item["allDay"] is True
    assert (item["startDate"], item["endDate"]) == ("2026-11-20", "2026-11-22")


def test_timed_event_is_shown_in_local_time():
    item = fetch.normalise_event({"summary": "Call", "start": {"dateTime": "2026-11-26T08:00:00Z"},
                                  "end": {"dateTime": "2026-11-26T09:30:00Z"}}, CALENDAR_COLOR)
    assert (item["startTime"], item["endTime"]) == ("09:00", "10:30")
    assert item["startDate"] == item["endDate"] == "2026-11-26"


def test_event_ending_at_midnight_stays_on_one_day():
    item = fetch.normalise_event({"start": {"dateTime": "2026-11-26T22:00:00+01:00"},
                                  "end": {"dateTime": "2026-11-27T00:00:00+01:00"}}, CALENDAR_COLOR)
    assert item["endDate"] == "2026-11-26"
    assert item["title"] == "(No title)"


def test_overnight_event_spans_two_days():
    item = fetch.normalise_event({"start": {"dateTime": "2026-11-26T22:00:00+01:00"},
                                  "end": {"dateTime": "2026-11-27T02:00:00+01:00"}}, CALENDAR_COLOR)
    assert (item["startDate"], item["endDate"]) == ("2026-11-26", "2026-11-27")


def test_event_colour_overrides_calendar_colour():
    item = fetch.normalise_event({"colorId": "11", "start": {"date": "2026-11-26"},
                                  "end": {"date": "2026-11-27"}}, CALENDAR_COLOR)
    assert item["color"] == "#d50000"


@pytest.mark.parametrize("event", [
    {"status": "cancelled", "start": {"date": "2026-11-26"}, "end": {"date": "2026-11-27"}},
    {"attendees": [{"self": True, "responseStatus": "declined"}],
     "start": {"date": "2026-11-26"}, "end": {"date": "2026-11-27"}},
])
def test_cancelled_and_declined_events_are_dropped(event):
    assert fetch.normalise_event(event, CALENDAR_COLOR) is None


def test_legacy_calendar_colour_maps_to_current_palette():
    assert fetch.current_calendar_color("#9FE1E7") == "#039be5"
    assert fetch.current_calendar_color("#123456") == "#123456"
    assert fetch.current_calendar_color(None) == fetch.FALLBACK_COLOR


def test_task_uses_due_date_and_completion():
    item = fetch.normalise_task({"title": "Pay VAT", "due": "2026-11-30T00:00:00.000Z",
                                 "status": "completed"}, date(2026, 11, 1), date(2026, 11, 30))
    assert (item["startDate"], item["done"], item["allDay"]) == ("2026-11-30", True, True)


@pytest.mark.parametrize("task", [
    {"title": "No date"},
    {"title": "Deleted", "due": "2026-11-10T00:00:00.000Z", "deleted": True},
    {"title": "Outside range", "due": "2026-12-01T00:00:00.000Z"},
])
def test_tasks_without_a_visible_due_date_are_dropped(task):
    assert fetch.normalise_task(task, date(2026, 11, 1), date(2026, 11, 30)) is None


def test_missing_login_file_is_fatal(tmp_path):
    with pytest.raises(fetch.FatalError, match="authorize.py"):
        fetch.load_token(str(tmp_path / "absent.json"))


def test_incomplete_login_file_is_fatal(tmp_path):
    token_file = tmp_path / "token.json"
    token_file.write_text('{"client_id": "x"}')
    with pytest.raises(fetch.FatalError, match="missing client_secret, refresh_token"):
        fetch.load_token(str(token_file))
