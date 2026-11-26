# gcal-desklet

Cinnamon desklet: Google Calendar month grid / 7-column week + Google Tasks. Public repo
`danielvazdar/cinnamon-gcal-desklet`. Personal tool, also published for others.

## Map
| Path | What |
|---|---|
| `gcal-month-week@danielvazdar/desklet.js` | lifecycle, header, navigation, fetch subprocess, cache, timer |
| `gcal-month-week@danielvazdar/views.js` | St widgets for month cells and week columns (drawing only) |
| `gcal-month-week@danielvazdar/layout.js` | pure date/size/fit logic, CommonJS, tested with Node |
| `gcal-month-week@danielvazdar/fetch.py` | Google Calendar + Tasks → normalised JSON on stdout (stdlib only) |
| `gcal-month-week@danielvazdar/authorize.py` | one-time OAuth (loopback + PKCE) → `~/.config/gcal-desklet/token.json` |
| `install.sh` | symlinks the desklet folder into `~/.local/share/cinnamon/desklets/` |

## Commands
- Tests: `.venv/bin/pytest -q tests && .venv/bin/ruff check . && node --test tests/*.test.js`
- Types: `.venv/bin/mypy --ignore-missing-imports gcal-month-week@danielvazdar/fetch.py gcal-month-week@danielvazdar/authorize.py`
- Reload: `gdbus call --session --dest org.Cinnamon --object-path /org/Cinnamon --method org.Cinnamon.ReloadXlet 'gcal-month-week@danielvazdar' 'DESKLET'`
- Logs: `~/.xsession-errors` (grep `gcal`)
- See it under windows: Eval `global.display.set_desklets_above(true)`, screenshot, then `false`.
  Never `deskletContainer.toggle()` (modal grab).

## Hard constraints
- St quirks: sizes are content-box; no CSS `opacity`; no per-side `border-*-color`;
  St.BoxLayout ignores Clutter x/y_align → use `box.add(actor, {expand, y_fill, y_align})`.
- Base class owns `this._header`, `this.content`, `this.actor`: don't reuse those names.
- Text metrics are measured on stage (`_measureTextAndRender`); text scaling changes line height.
- Public repo: no login files, no real calendar data or screenshots of it, no account names.
  `docs/THIRD_PARTY_ACCOUNTS.md` is gitignored on purpose.
- Decisions → `DECISIONS.md`.
