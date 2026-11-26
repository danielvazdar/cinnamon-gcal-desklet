# Google Calendar desklet for Cinnamon: month and week

A desktop widget for Linux Mint (Cinnamon) that shows your Google Calendar as a full month or a
7-day week, with your Google Tasks on their due dates. Dark glass look, every calendar in its
Google colour.

- **Month view:** each day lists its events as time and title on up to two lines. If a day has more
  than fits, "+N more" opens that week.
- **Week view:** seven columns with full titles and time ranges.
- **Tasks:** Google Tasks with a due date show on that day; done ones are struck through. The Tasks
  API keeps only the date, so tasks have no time.
- Click an event to open it in Google Calendar, or a day number to open that day.
- It shows the calendars you have ticked in Google Calendar and only ever reads.

Tested on Cinnamon 6.6. Needs Python 3.10+ (standard library only).

## Install

```sh
git clone https://github.com/danielvazdar/cinnamon-gcal-desklet.git
cd cinnamon-gcal-desklet
./install.sh
```

Then right-click the desktop → **Add Desklets** → **Google Calendar: Month & Week**.

## Connect your Google account (once)

Google wants each user of a home-made app like this to bring their own OAuth client. It is free.

1. Open [Google Cloud console](https://console.cloud.google.com/) and create a project.
2. **APIs & Services → Library:** enable **Google Calendar API** and **Google Tasks API**.
3. **Google Auth Platform → Audience:** choose *External*, then **Publish app**. Google expires
   logins of apps left in *Testing* after 7 days. When you log in, Google warns that the app is
   unverified; it is your own app, so continue.
4. **Google Auth Platform → Clients → Create client:** type *Desktop app*. Download the JSON.
5. Run, and allow access in the browser window that opens:

   ```sh
   python3 ~/.local/share/cinnamon/desklets/gcal-month-week@osobno/authorize.py ~/Downloads/client_secret_*.json
   ```

6. Click the refresh icon on the widget.

The login is saved to `~/.config/gcal-desklet/token.json`, readable only by your user.

## Settings

Right-click the widget → **Configure**: width, height, text size, background darkness, refresh interval.

## Development

```sh
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q tests && .venv/bin/ruff check . && node --test tests/*.test.js
# reload the running widget after a change:
gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon \
  --method org.Cinnamon.ReloadXlet 'gcal-month-week@osobno' 'DESKLET'
```

`layout.js` (dates, sizes, what fits in a cell) is plain JavaScript and tested with Node.
`fetch.py` turns Google's answers into the list the widget draws and is tested with pytest.

## License

MIT
