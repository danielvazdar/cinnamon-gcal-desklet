"""Fetch Google Calendar events and Google Tasks for a date range and print them as JSON.

Run by the desklet:  python3 -I fetch.py --start 2026-10-26 --end 2026-12-06
Both dates are inclusive local days. Standard library only.

Output (stdout, exit 0):
  {"fetchedAt": "...", "items": [...], "warnings": ["..."]}
  Each item: kind (event|task), title, color, allDay, startDate, endDate (inclusive),
  startTime/endTime ("HH:MM" local, timed events only), link, done (tasks only).
Fatal problems (no login, login revoked) print {"fatal": "..."} and exit 2.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

TOKEN_PATH_DEFAULT = os.path.expanduser("~/.config/gcal-desklet/token.json")
TOKEN_URI = "https://oauth2.googleapis.com/token"
CALENDAR_API = "https://www.googleapis.com/calendar/v3"
TASKS_API = "https://tasks.googleapis.com/tasks/v1"
TASKS_SCOPE = "https://www.googleapis.com/auth/tasks.readonly"
HTTP_TIMEOUT_SECONDS = 15
MAX_PARALLEL_REQUESTS = 8
TASK_COLOR = "#4285f4"
FALLBACK_COLOR = "#039be5"

# Event colours as Google Calendar shows them today. The API's /colors endpoint
# still returns the old pastel palette, so the current one is kept here.
EVENT_COLORS = {
    "1": "#7986cb", "2": "#33b679", "3": "#8e24aa", "4": "#e67c73",
    "5": "#f6bf26", "6": "#f4511e", "7": "#039be5", "8": "#616161",
    "9": "#3f51b5", "10": "#0b8043", "11": "#d50000",
}
# Calendar colours come back from calendarList in the same old palette; map them to what the UI shows.
LEGACY_TO_CURRENT_CALENDAR_COLORS = {
    "#ac725e": "#795548", "#d06b64": "#e67c73", "#f83a22": "#d50000", "#fa573c": "#f4511e",
    "#ff7537": "#ef6c00", "#ffad46": "#f09300", "#42d692": "#009688", "#16a765": "#0b8043",
    "#7bd148": "#7cb342", "#b3dc6c": "#c0ca33", "#fbe983": "#e4c441", "#fad165": "#f6bf26",
    "#92e1c0": "#33b679", "#9fe1e7": "#039be5", "#9fc6e7": "#4285f4", "#4986e7": "#3f51b5",
    "#9a9cff": "#7986cb", "#b99aff": "#b39ddb", "#c2c2c2": "#616161", "#cabdbf": "#a79b8e",
    "#cca6ac": "#d81b60", "#f691b2": "#ad1457", "#cd74e6": "#8e24aa", "#a47ae2": "#9e69af",
}


class FatalError(Exception):
    """Nothing can be fetched: the desklet shows this message instead of the calendar."""


class GoogleApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status


# ---------------------------------------------------------------- HTTP + auth

def http_json(url: str, *, access_token: str | None = None, form: dict | None = None) -> dict:
    data = urllib.parse.urlencode(form).encode() if form is not None else None
    request = urllib.request.Request(url, data=data)
    if access_token:
        request.add_header("Authorization", f"Bearer {access_token}")
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise GoogleApiError(error.code, google_error_message(error)) from None


def google_error_message(error: urllib.error.HTTPError) -> str:
    try:
        body = json.load(error)
    except (ValueError, OSError):
        return error.reason or "unknown error"
    detail = body.get("error")
    if isinstance(detail, dict):
        return detail.get("message", "unknown error")
    return body.get("error_description") or str(detail)


def load_token(token_path: str) -> dict:
    try:
        with open(token_path, encoding="utf-8") as handle:
            token = json.load(handle)
    except FileNotFoundError:
        raise FatalError("Not connected to Google yet. Run authorize.py once.") from None
    missing = [key for key in ("client_id", "client_secret", "refresh_token") if not token.get(key)]
    if missing:
        raise FatalError(f"Login file is incomplete (missing {', '.join(missing)}). Run authorize.py.")
    return token


def refresh_access_token(token: dict) -> tuple[str, set[str]]:
    """Trade the stored refresh token for a short-lived access token and its granted scopes."""
    try:
        response = http_json(token.get("token_uri", TOKEN_URI), form={
            "client_id": token["client_id"],
            "client_secret": token["client_secret"],
            "refresh_token": token["refresh_token"],
            "grant_type": "refresh_token",
        })
    except GoogleApiError as error:
        if error.status in (400, 401):
            raise FatalError("Google login expired or was revoked. Run authorize.py again.") from None
        raise
    return response["access_token"], set(response.get("scope", "").split())


def get_all_pages(url: str, params: dict, access_token: str) -> list[dict]:
    items: list[dict] = []
    page_token = None
    while True:
        page_params = {**params, **({"pageToken": page_token} if page_token else {})}
        page = http_json(f"{url}?{urllib.parse.urlencode(page_params)}", access_token=access_token)
        items.extend(page.get("items", []))
        page_token = page.get("nextPageToken")
        if not page_token:
            return items


# ---------------------------------------------------------------- normalising (pure)

def local_midnight_iso(day: date) -> str:
    return datetime(day.year, day.month, day.day).astimezone().isoformat()


def current_calendar_color(legacy_color: str | None) -> str:
    if not legacy_color:
        return FALLBACK_COLOR
    return LEGACY_TO_CURRENT_CALENDAR_COLORS.get(legacy_color.lower(), legacy_color)


def is_declined_by_me(event: dict) -> bool:
    return any(a.get("self") and a.get("responseStatus") == "declined"
               for a in event.get("attendees", []))


def normalise_event(event: dict, calendar_color: str) -> dict | None:
    if event.get("status") == "cancelled" or is_declined_by_me(event):
        return None
    start, end = event.get("start", {}), event.get("end", {})
    base = {
        "kind": "event",
        "title": event.get("summary") or "(No title)",
        "color": EVENT_COLORS.get(event.get("colorId", ""), calendar_color),
        "link": event.get("htmlLink", ""),
    }
    if "date" in start:
        last_day = date.fromisoformat(end.get("date", start["date"])) - timedelta(days=1)
        first_day = date.fromisoformat(start["date"])
        return {**base, "allDay": True, "startDate": first_day.isoformat(),
                "endDate": max(first_day, last_day).isoformat()}
    starts_at = datetime.fromisoformat(start["dateTime"]).astimezone()
    ends_at = datetime.fromisoformat(end.get("dateTime", start["dateTime"])).astimezone()
    # An event ending exactly at midnight does not occupy the next day.
    last_moment = ends_at - timedelta(microseconds=1) if ends_at > starts_at else ends_at
    return {**base, "allDay": False,
            "startDate": starts_at.date().isoformat(), "endDate": last_moment.date().isoformat(),
            "startTime": starts_at.strftime("%H:%M"), "endTime": ends_at.strftime("%H:%M")}


def normalise_task(task: dict, first_day: date, last_day: date) -> dict | None:
    due = task.get("due")
    if not due or task.get("deleted"):
        return None
    # The Tasks API stores only a due DATE (time is always midnight UTC), so read the date part.
    due_day = date.fromisoformat(due[:10])
    if not first_day <= due_day <= last_day:
        return None
    return {
        "kind": "task",
        "title": task.get("title") or "(No title)",
        "color": TASK_COLOR,
        "allDay": True,
        "startDate": due_day.isoformat(),
        "endDate": due_day.isoformat(),
        "link": task.get("webViewLink") or "https://tasks.google.com/",
        "done": task.get("status") == "completed",
    }


# ---------------------------------------------------------------- fetching

def fetch_calendar_events(calendar: dict, first_day: date, last_day: date, access_token: str) -> list[dict]:
    url = f"{CALENDAR_API}/calendars/{urllib.parse.quote(calendar['id'], safe='')}/events"
    events = get_all_pages(url, {
        "timeMin": local_midnight_iso(first_day),
        "timeMax": local_midnight_iso(last_day + timedelta(days=1)),
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": "2500",
        "fields": "nextPageToken,items(summary,start,end,htmlLink,colorId,status,attendees(self,responseStatus))",
    }, access_token)
    color = current_calendar_color(calendar.get("backgroundColor"))
    return [item for item in (normalise_event(e, color) for e in events) if item]


def fetch_task_list(task_list: dict, first_day: date, last_day: date, access_token: str) -> list[dict]:
    tasks = get_all_pages(f"{TASKS_API}/lists/{urllib.parse.quote(task_list['id'], safe='')}/tasks", {
        "dueMin": f"{first_day.isoformat()}T00:00:00Z",
        "dueMax": f"{(last_day + timedelta(days=1)).isoformat()}T00:00:00Z",
        "showCompleted": "true",
        "showHidden": "true",
        "maxResults": "100",
    }, access_token)
    return [item for item in (normalise_task(t, first_day, last_day) for t in tasks) if item]


def fetch_everything(first_day: date, last_day: date, token_path: str) -> dict:
    access_token, granted_scopes = refresh_access_token(load_token(token_path))
    warnings: list[str] = []

    calendars = [c for c in get_all_pages(f"{CALENDAR_API}/users/me/calendarList", {
        "fields": "nextPageToken,items(id,summary,summaryOverride,backgroundColor,selected)",
    }, access_token) if c.get("selected")]

    FetchJob = tuple[str, Callable[[dict, date, date, str], list[dict]], dict]
    jobs: list[FetchJob] = [(f"Calendar '{c.get('summaryOverride') or c.get('summary')}'", fetch_calendar_events, c)
            for c in calendars]
    if TASKS_SCOPE in granted_scopes:
        task_lists = get_all_pages(f"{TASKS_API}/users/@me/lists", {"maxResults": "100"}, access_token)
        jobs += [(f"Task list '{t.get('title')}'", fetch_task_list, t) for t in task_lists]
    else:
        warnings.append("Tasks not connected yet")

    items: list[dict] = []
    with ThreadPoolExecutor(max_workers=MAX_PARALLEL_REQUESTS) as pool:
        futures = [(label, pool.submit(job, source, first_day, last_day, access_token))
                   for label, job, source in jobs]
        for label, future in futures:
            try:
                items.extend(future.result())
            except (GoogleApiError, OSError) as error:
                warnings.append(f"{label} failed: {error}")

    return {"fetchedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "items": items, "warnings": warnings}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--start", required=True, type=date.fromisoformat, help="first day, YYYY-MM-DD")
    parser.add_argument("--end", required=True, type=date.fromisoformat, help="last day, YYYY-MM-DD")
    parser.add_argument("--token", default=TOKEN_PATH_DEFAULT, help="login file written by authorize.py")
    args = parser.parse_args()
    if args.end < args.start:
        parser.error("--end is before --start")
    try:
        result = fetch_everything(args.start, args.end, args.token)
    except FatalError as error:
        print(json.dumps({"fatal": str(error)}))
        return 2
    except (GoogleApiError, OSError) as error:
        print(json.dumps({"fatal": f"Could not reach Google: {error}"}))
        return 2
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
