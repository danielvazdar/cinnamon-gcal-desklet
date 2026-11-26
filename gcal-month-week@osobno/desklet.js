// Google Calendar desklet: month grid or 7-column week, events + Google Tasks.
// Data comes from fetch.py (run as a subprocess); drawing lives in views.js.

const Main = imports.ui.main;
const Desklet = imports.ui.desklet;
const Settings = imports.ui.settings;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const Cinnamon = imports.gi.Cinnamon;
const Layout = require('./layout');
const Views = require('./views');

const UUID = 'gcal-month-week@osobno';
const MAX_CACHED_RANGES = 6;
const ENTER_ANIMATION_MS = 280;
const ENTER_SLIDE_PX = 24;
const SPIN_DURATION_MS = 900;
const GOOGLE_DAY_URL = 'https://calendar.google.com/calendar/r/day/';
const TEXT_SAMPLE = 'Weekly planning call with the team 10:30';

function todayString() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d');
}

function dateTimeOf(day) {
    const [year, month, date] = day.split('-').map(Number);
    return GLib.DateTime.new_local(year, month, date, 0, 0, 0);
}

function capitalise(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function lastLine(text) {
    return (text || '').trim().split('\n').pop();
}

// Cinnamon opens a desklet's menu beside the desklet; when the desklet fills the screen width the menu
// ends up off-screen. Open it where the user right-clicked instead, kept inside that monitor.
function openMenuAtPointer(menu) {
    menu._calculatePosition = function () {
        if (!this.actor.visible)
            this.box.show();
        const [pointerX, pointerY] = global.get_pointer();
        const [, , naturalWidth, naturalHeight] = this.actor.get_preferred_size();
        const monitor = Main.layoutManager.findMonitorForActor(this.sourceActor);
        const x = Math.min(Math.max(pointerX, monitor.x), monitor.x + monitor.width - naturalWidth);
        const y = Math.min(Math.max(pointerY, monitor.y), monitor.y + monitor.height - naturalHeight);
        return [Math.round(x), Math.round(y)];
    };
}

class GoogleCalendarDesklet extends Desklet.Desklet {
    constructor(metadata, deskletId) {
        super(metadata, deskletId);
        openMenuAtPointer(this._menu);
        this._weekStart = Cinnamon.util_get_week_start();
        this._today = todayString();
        this._anchorDay = this._today;
        this._cache = new Map();
        this._inFlight = new Set();
        this._problem = null;
        this._timerId = 0;
        this._textMetrics = {};
        this._python = GLib.find_program_in_path('python3');

        this.settings = new Settings.DeskletSettings(this, UUID, deskletId);
        const redrawingSettings = {width: 'widthPx', height: 'heightPx', 'font-size': 'fontSizePx',
            'glass-opacity': 'glassOpacity'};
        for (const [key, property] of Object.entries(redrawingSettings))
            this.settings.bind(key, property, () => this._measureTextAndRender());
        this.settings.bind('refresh-minutes', 'refreshMinutes', () => this._startTimer());
        this.settings.bind('view', 'view');

        this._buildFrame();
        this._render();
        this._fetchVisibleRange();
        this._startTimer();
    }

    // ------------------------------------------------------------ frame + header

    _buildFrame() {
        this._root = new St.BoxLayout({vertical: true, style_class: 'gcal-root'});
        this._toolbar = new St.BoxLayout({style_class: 'gcal-header'});
        this._title = Views.makeLabel('', 'gcal-title');
        this._prevButton = this._iconButton('go-previous-symbolic', () => this._step(-1));
        this._nextButton = this._iconButton('go-next-symbolic', () => this._step(1));
        this._todayButton = this._textButton('Today', 'gcal-pill', () => this._goTo(this._today, 0));
        this._monthTab = this._textButton('Month', 'gcal-tab', () => this._setView('month'));
        this._weekTab = this._textButton('Week', 'gcal-tab', () => this._setView('week'));
        this._status = Views.makeLabel('', 'gcal-status');
        this._refreshIcon = new St.Icon({icon_name: 'view-refresh-symbolic', style_class: 'gcal-icon'});
        this._refreshIcon.set_pivot_point(0.5, 0.5);
        const refreshButton = this._buttonAround(this._refreshIcon, 'gcal-icon-button', () => this._fetchVisibleRange());

        const tabs = new St.BoxLayout({style_class: 'gcal-tabs'});
        tabs.add_actor(this._monthTab);
        tabs.add_actor(this._weekTab);
        for (const actor of [this._prevButton, this._title, this._nextButton, this._todayButton])
            this._toolbar.add(actor, Views.CENTERED);
        this._toolbar.add(new St.Widget(), {expand: true});
        for (const actor of [this._status, refreshButton, tabs])
            this._toolbar.add(actor, Views.CENTERED);

        this._bodyHolder = new St.Bin({x_fill: true, y_fill: true});
        this._root.add_actor(this._toolbar);
        this._root.add_actor(this._bodyHolder);
        this.setContent(this._root);
    }

    on_desklet_added_to_desktop() {
        this._measureTextAndRender();
    }

    // Line height and character width of the real font (theme font, text scaling); layout.sizesFor needs them.
    _measureTextAndRender() {
        const probe = new St.Label({text: TEXT_SAMPLE, style_class: 'gcal-chip-text',
            style: `font-size: ${this.fontSizePx}px;`});
        this._root.add_actor(probe);
        const [, height] = probe.get_preferred_height(-1);
        const [, width] = probe.get_preferred_width(-1);
        probe.destroy();
        this._textMetrics = height > 0
            ? {lineHeight: Math.ceil(height), averageCharWidth: width / TEXT_SAMPLE.length} : {};
        this._render();
    }

    _buttonAround(child, styleClass, onClicked) {
        const button = new St.Button({child, style_class: styleClass, reactive: true, track_hover: true});
        button.connect('clicked', onClicked);
        return button;
    }

    _iconButton(iconName, onClicked) {
        return this._buttonAround(new St.Icon({icon_name: iconName, style_class: 'gcal-icon'}),
            'gcal-icon-button', onClicked);
    }

    _textButton(text, styleClass, onClicked) {
        return this._buttonAround(Views.makeLabel(text, `${styleClass}-text`), styleClass, onClicked);
    }

    // ------------------------------------------------------------ navigation

    _visibleWeeks() {
        if (this.view === 'week')
            return [Layout.weekDays(this._anchorDay, this._weekStart)];
        const [year, month] = this._anchorDay.split('-').map(Number);
        return Layout.monthWeeks(year, month, this._weekStart);
    }

    _visibleRange() {
        const weeks = this._visibleWeeks();
        return {first: weeks[0][0], last: weeks.at(-1).at(-1)};
    }

    _step(direction) {
        if (this.view === 'week') {
            this._goTo(Layout.addDays(this._anchorDay, 7 * direction), direction);
            return;
        }
        const [year, month] = this._anchorDay.split('-').map(Number);
        const target = GLib.DateTime.new_local(year, month, 1, 0, 0, 0).add_months(direction);
        this._goTo(target.format('%Y-%m-%d'), direction);
    }

    _goTo(day, direction) {
        this._anchorDay = day;
        this._render({slideFrom: direction});
        this._fetchVisibleRange();
    }

    _setView(view) {
        if (this.view === view)
            return;
        this.view = view;
        this._render({slideFrom: 0});
        this._fetchVisibleRange();
    }

    _showWeekOf(day) {
        this.view = 'week';
        this._goTo(day, 0);
    }

    // ------------------------------------------------------------ drawing

    _render({slideFrom = null} = {}) {
        const weeks = this._visibleWeeks();
        const sizes = Layout.sizesFor({width: this.widthPx, height: this.heightPx, fontSize: this.fontSizePx,
            ...this._textMetrics}, weeks.length);
        this._applyFrameStyle(sizes);
        this._updateHeader(weeks);

        const data = this._dataFor(this._visibleRange());
        const days = weeks.flat();
        const context = {
            weeks, days, sizes, today: this._today,
            month: Number(this._anchorDay.slice(5, 7)),
            itemsByDay: Layout.itemsByDay(Layout.withoutDuplicates(data ? data.items : []), days),
            formatWeekday: day => dateTimeOf(day).format('%a'),
            actions: {
                openLink: uri => this._openUri(uri),
                openDay: day => this._openUri(GOOGLE_DAY_URL + day.replace(/-/g, '/')),
                showWeekOf: day => this._showWeekOf(day),
            },
        };
        const body = this.view === 'week' ? Views.buildWeekView(context) : Views.buildMonthView(context);
        const previousBody = this._bodyHolder.get_child();
        this._bodyHolder.set_child(body);
        if (previousBody)
            previousBody.destroy();
        if (slideFrom !== null)
            this._animateIn(body, slideFrom);
    }

    _applyFrameStyle(sizes) {
        const alpha = this.glassOpacity;
        this._root.set_style(`width: ${sizes.rootContentWidth}px; height: ${sizes.rootContentHeight}px;`
            + ` font-size: ${this.fontSizePx}px;`
            + ` padding: ${sizes.outerPadding}px;`
            + ` background-gradient-start: rgba(34, 38, 52, ${alpha});`
            + ` background-gradient-end: rgba(12, 14, 20, ${Math.min(alpha + 0.12, 1)});`);
        this._toolbar.set_style(`height: ${sizes.headerHeight}px;`);
    }

    _updateHeader(weeks) {
        const firstDay = dateTimeOf(weeks[0][0]);
        const lastDay = dateTimeOf(weeks.at(-1).at(-1));
        let title = dateTimeOf(this._anchorDay).format('%OB %Y');
        if (this.view === 'week' && firstDay.get_month() !== lastDay.get_month())
            title = `${firstDay.format('%OB')} – ${lastDay.format('%OB %Y')}`;
        this._title.set_text(capitalise(title));
        this._monthTab.change_style_pseudo_class('checked', this.view !== 'week');
        this._weekTab.change_style_pseudo_class('checked', this.view === 'week');
        this._updateStatus();
    }

    _updateStatus() {
        const data = this._dataFor(this._visibleRange());
        let text = '';
        let isProblem = false;
        if (this._problem) {
            [text, isProblem] = [this._problem, true];
        } else if (data && data.warnings.length) {
            [text, isProblem] = [data.warnings.join(' · '), true];
        } else if (data) {
            text = `Updated ${GLib.DateTime.new_from_iso8601(data.fetchedAt, null).to_local().format('%H:%M')}`;
        } else if (this._inFlight.size) {
            text = 'Loading…';
        }
        this._status.set_text(text);
        this._status.change_style_pseudo_class('problem', isProblem);
    }

    _animateIn(actor, direction) {
        actor.opacity = 0;
        actor.translation_x = direction * ENTER_SLIDE_PX;
        actor.ease({opacity: 255, translation_x: 0, duration: ENTER_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }

    _setSpinning(spinning) {
        this._refreshIcon.remove_all_transitions();
        this._refreshIcon.rotation_angle_z = 0;
        if (spinning) {
            this._refreshIcon.ease({rotation_angle_z: 360, duration: SPIN_DURATION_MS, repeatCount: -1,
                mode: Clutter.AnimationMode.LINEAR});
        }
    }

    _openUri(uri) {
        if (!uri)
            return;
        try {
            Gio.app_info_launch_default_for_uri(uri, global.create_app_launch_context());
        } catch (error) {
            global.logError(`${UUID}: could not open ${uri}: ${error.message}`);
        }
    }

    // ------------------------------------------------------------ data

    _fetchVisibleRange() {
        const range = this._visibleRange();
        const key = `${range.first}..${range.last}`;
        if (this._inFlight.has(key))
            return;
        if (!this._python) {
            this._problem = 'python3 not found';
            this._updateStatus();
            return;
        }
        let process;
        try {
            process = Gio.Subprocess.new(
                [this._python, '-I', `${this.metadata.path}/fetch.py`, '--start', range.first, '--end', range.last],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (error) {
            this._problem = `Could not start fetch: ${error.message}`;
            this._updateStatus();
            return;
        }
        this._inFlight.add(key);
        this._setSpinning(true);
        this._updateStatus();
        process.communicate_utf8_async(null, null, (proc, result) => this._onFetched(key, proc, result));
    }

    _onFetched(key, process, asyncResult) {
        this._inFlight.delete(key);
        if (this._removed)
            return;
        this._setSpinning(this._inFlight.size > 0);
        let stdout = '';
        let stderr = '';
        try {
            [, stdout, stderr] = process.communicate_utf8_finish(asyncResult);
            const result = JSON.parse(stdout);
            this._problem = result.fatal || null;
            if (!result.fatal)
                this._remember(key, result);
        } catch (error) {
            this._problem = `Fetch failed: ${lastLine(stderr) || error.message}`;
            global.logError(`${UUID}: fetch failed: ${error.message}\n${stderr}`);
        }
        const range = this._visibleRange();
        if (key === `${range.first}..${range.last}`)
            this._render();
        else
            this._updateStatus();
    }

    // The exact range if fetched, else any cached range that covers it (week view right after month view).
    _dataFor(range) {
        const exact = this._cache.get(`${range.first}..${range.last}`);
        if (exact)
            return exact;
        for (const [key, data] of this._cache) {
            const [first, last] = key.split('..');
            if (first <= range.first && range.last <= last)
                return data;
        }
        return null;
    }

    _remember(key, result) {
        this._cache.delete(key);
        this._cache.set(key, result);
        while (this._cache.size > MAX_CACHED_RANGES)
            this._cache.delete(this._cache.keys().next().value);
    }

    // ------------------------------------------------------------ timer + lifecycle

    _startTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, Math.max(1, this.refreshMinutes) * 60, () => {
            this._onTick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onTick() {
        const today = todayString();
        if (today !== this._today) {
            const anchorWasToday = this._anchorDay === this._today;
            this._today = today;
            if (anchorWasToday)
                this._anchorDay = today;
            this._render();
        }
        this._fetchVisibleRange();
    }

    on_desklet_removed() {
        this._removed = true;
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
        this.settings.finalize();
    }
}

function main(metadata, deskletId) {
    return new GoogleCalendarDesklet(metadata, deskletId);
}
