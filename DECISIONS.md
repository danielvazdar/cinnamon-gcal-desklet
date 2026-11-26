# Decisions

| Date | Decision | Why |
|---|---|---|
| 2026-11-26 | Build our own desklet; replaces `googleCalendar@javahelps.com` + `calendar@deeppradhan` on the tall left screen | No existing desklet shows a month with events or a week view |
| 2026-11-26 | Week view = 7 columns; look = dark glass (Daniel's picks) | Asked with mock-ups |
| 2026-11-26 | Events + Google Tasks (Daniel's pick) | Tasks need their own OAuth client with `tasks.readonly` |
| 2026-11-26 | Data via `fetch.py` subprocess, Python stdlib only | Testable, no venv for users, desklet JS stays drawing-only |
| 2026-11-26 | Own OAuth client per user via `authorize.py` (loopback + PKCE) | gcalendar's shared client only covers calendar; public users need their own |
| 2026-11-26 | Show the calendars ticked in Google (`selected`); no picker in the widget | One place to choose, no extra settings |
| 2026-11-26 | Month chips: time inline, 1–2 lines, "+N more" opens the week; duplicates across calendars shown once | First build cut titles after ~6 letters; two holiday calendars doubled holidays |
| 2026-11-26 | Line height and char width measured on stage | 1.1 text scaling made planned 2-line chips collapse to 1 |
| 2026-11-26 | Public repo, MIT (Daniel asked for public) | Useful to other Mint users |
| 2026-11-26 | Daniel: events only, no Tasks. His widget keeps the login copied from gcalendar (calendar-only). A login without the Tasks permission shows events with no warning | Declining Tasks is a choice, not an error; authorize.py already reports what was granted |
