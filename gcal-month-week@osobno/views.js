// Builds the month grid and the 7-column week view out of St widgets.
// Everything here is drawing only: data, navigation and fetching live in desklet.js.
// Cinnamon's St.BoxLayout ignores Clutter's x/y_align, so alignment goes through box.add(actor, {...}).

const St = imports.gi.St;
const GLib = imports.gi.GLib;
const Pango = imports.gi.Pango;
const Layout = require('./layout');

const TASK_OPEN_MARK = '○';
const TASK_DONE_MARK = '✓';
const OPACITY_DONE = 120;
const OPACITY_PAST = 165;
const TIME_ALPHA = '62%';
const CENTERED = {y_fill: false, y_align: St.Align.MIDDLE};

// St CSS has no opacity property, so fading is set on the actor.
function chipOpacity(item, onPastDay) {
    if (item.done)
        return OPACITY_DONE;
    return onPastDay ? OPACITY_PAST : 255;
}

function makeLabel(text, styleClass, {wrap = false, style = ''} = {}) {
    const label = new St.Label({text, style_class: styleClass});
    if (style) // an empty style string makes St log a parser error
        label.set_style(style);
    label.clutter_text.set_ellipsize(wrap ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END);
    if (wrap) {
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
    }
    return label;
}

// Title with a checkbox mark for tasks (struck through when done), optionally led by a dimmed "9:00".
function chipMarkup(item, {withTime}) {
    const prefix = item.kind === 'task' ? `${item.done ? TASK_DONE_MARK : TASK_OPEN_MARK} ` : '';
    const escaped = GLib.markup_escape_text(prefix + item.title, -1);
    const title = item.done ? `<s>${escaped}</s>` : escaped;
    if (!withTime || item.allDay || !item.startTime)
        return title;
    return `<span font_weight="600" fgalpha="${TIME_ALPHA}">${Layout.shortTime(item.startTime)}</span> ${title}`;
}

function makeButton(child, styleClass, style, onClicked, opacity = 255) {
    const button = new St.Button({child, style_class: styleClass, style, reactive: true,
        track_hover: true, x_fill: true, y_fill: true, opacity});
    button.connect('clicked', onClicked);
    return button;
}

// The calendar's colour as a thin vertical bar at the start of a timed event.
function colourBar(item, sizes) {
    return new St.Widget({style_class: 'gcal-chip-bar',
        style: `width: ${sizes.chipBarWidth}px; background-color: ${item.color};`});
}

function filledStyle(item) {
    return `background-color: ${item.color};`;
}

// A month-cell chip on 1 or 2 lines, ending in "…" when the text is longer.
// All-day items and tasks are filled with their colour; timed events get a colour bar and "9:00 Title".
function monthChip({item, lines}, sizes, actions, onPastDay) {
    const textColor = item.allDay ? ` color: ${Layout.textColorOn(item.color)};` : '';
    const label = makeLabel('', 'gcal-chip-text', {wrap: true, style: `height: ${lines * sizes.lineHeight}px;${textColor}`});
    label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
    label.clutter_text.set_markup(chipMarkup(item, {withTime: true}));
    const row = new St.BoxLayout({style: `spacing: ${sizes.chipBarGap}px;`});
    if (!item.allDay)
        row.add(colourBar(item, sizes), {y_fill: true});
    row.add(label, {expand: true});
    return makeButton(row, `gcal-chip${item.allDay ? ' gcal-chip-filled' : ''}`,
        `padding: ${sizes.chipPaddingY}px ${sizes.chipPaddingX}px;${item.allDay ? ` ${filledStyle(item)}` : ''}`,
        () => actions.openLink(item.link), chipOpacity(item, onPastDay));
}

// Day number in a pill; today's is filled. Clicking opens that day in Google Calendar.
function dayNumber(day, isToday, sizes, actions) {
    const label = makeLabel(String(Number(day.slice(8))), 'gcal-day-number-text',
        {style: `min-width: ${sizes.dayPillSize - 2 * sizes.dayPillPaddingX}px; text-align: center;`});
    return makeButton(label, `gcal-day-number${isToday ? ' is-today' : ''}`,
        `padding: ${sizes.dayPillPaddingY}px ${sizes.dayPillPaddingX}px; border-radius: ${sizes.dayPillSize}px;`,
        () => actions.openDay(day));
}

function monthCell(day, dayItems, context) {
    const {sizes, today, month, actions} = context;
    const isOtherMonth = Number(day.slice(5, 7)) !== month;
    const classes = ['gcal-cell'];
    if (day === today)
        classes.push('is-today');
    if (isOtherMonth)
        classes.push('is-other-month');
    else if (day < today)
        classes.push('is-past');
    const cell = new St.BoxLayout({vertical: true, style_class: classes.join(' '),
        style: `width: ${sizes.cellContentWidth}px; height: ${sizes.cellContentHeight}px; padding: ${sizes.cellPadding}px; spacing: ${sizes.chipGap}px;`});
    const numberRow = new St.BoxLayout({style: `height: ${sizes.dayNumberHeight}px;`});
    numberRow.add(dayNumber(day, day === today, sizes, actions), {x_fill: false, ...CENTERED});
    cell.add_actor(numberRow);

    const plan = Layout.planCell(dayItems, sizes);
    for (const chip of plan.chips)
        cell.add_actor(monthChip(chip, sizes, actions, isOtherMonth || day < today));
    if (plan.hiddenCount > 0) {
        const more = makeLabel(`+${plan.hiddenCount} more`, 'gcal-more-text', {style: `height: ${sizes.lineHeight}px;`});
        cell.add(makeButton(more, 'gcal-more', `padding: ${sizes.chipPaddingY + sizes.chipBorder}px ${sizes.chipPaddingX}px;`,
            () => actions.showWeekOf(day)), {x_fill: false, x_align: St.Align.START});
    }
    return cell;
}

function weekdayHeaderRow(days, sizes, formatWeekday) {
    const row = new St.BoxLayout({style: `height: ${sizes.weekdayRowHeight}px; spacing: ${sizes.gridGap}px;`});
    for (const day of days) {
        row.add(makeLabel(formatWeekday(day).toUpperCase(), 'gcal-weekday',
            {style: `width: ${sizes.cellWidth - sizes.cellInset - 4}px; padding-left: ${sizes.cellInset + 4}px;`}), CENTERED);
    }
    return row;
}

// context: {weeks, itemsByDay, today, month, sizes, formatWeekday, actions}
function buildMonthView(context) {
    const {weeks, itemsByDay, sizes} = context;
    const body = new St.BoxLayout({vertical: true, style: `spacing: ${sizes.gridGap}px;`});
    body.add_actor(weekdayHeaderRow(weeks[0], sizes, context.formatWeekday));
    for (const week of weeks) {
        const row = new St.BoxLayout({style: `spacing: ${sizes.gridGap}px;`});
        for (const day of week)
            row.add_actor(monthCell(day, itemsByDay.get(day), context));
        body.add_actor(row);
    }
    return body;
}

// A week-column chip: time range on its own line, then the full title, wrapped.
function weekChip(item, sizes, actions, onPastDay) {
    const opacity = chipOpacity(item, onPastDay);
    const text = new St.BoxLayout({vertical: true});
    const title = makeLabel('', 'gcal-week-title',
        {wrap: true, style: item.allDay ? `color: ${Layout.textColorOn(item.color)};` : ''});
    title.clutter_text.set_markup(chipMarkup(item, {withTime: false}));
    if (item.allDay) {
        text.add_actor(title);
        return makeButton(text, 'gcal-week-chip gcal-chip-filled', filledStyle(item),
            () => actions.openLink(item.link), opacity);
    }
    const start = Layout.shortTime(item.startTime);
    const time = item.endTime && item.endDate === item.startDate ? `${start} – ${Layout.shortTime(item.endTime)}` : start;
    text.add_actor(makeLabel(time, 'gcal-week-time'));
    text.add_actor(title);
    const row = new St.BoxLayout({style: `spacing: ${sizes.chipBarGap}px;`});
    row.add(colourBar(item, sizes), {y_fill: true});
    row.add(text, {expand: true});
    return makeButton(row, 'gcal-week-chip', '', () => actions.openLink(item.link), opacity);
}

function weekColumn(day, dayItems, context) {
    const {sizes, today, actions, formatWeekday} = context;
    const isToday = day === today;
    const column = new St.BoxLayout({vertical: true,
        style_class: `gcal-week-column${isToday ? ' is-today' : ''}${day < today ? ' is-past' : ''}`,
        style: `width: ${sizes.cellContentWidth}px; height: ${sizes.weekColumnContentHeight}px; padding: ${sizes.cellPadding}px; spacing: 6px;`});

    const header = new St.BoxLayout({style: `spacing: ${sizes.cellPadding}px; height: ${sizes.dayNumberHeight}px;`});
    header.add(makeLabel(formatWeekday(day).toUpperCase(), 'gcal-weekday', {style: 'padding-left: 4px;'}), CENTERED);
    header.add(dayNumber(day, isToday, sizes, actions), {x_fill: false, ...CENTERED});
    column.add_actor(header);

    // A ScrollView gives its child only its natural width, so the list is sized to the column.
    const list = new St.BoxLayout({vertical: true, style: `spacing: 4px; width: ${sizes.cellContentWidth}px;`});
    for (const item of dayItems)
        list.add_actor(weekChip(item, sizes, actions, day < today));
    if (dayItems.length === 0)
        list.add_actor(makeLabel('·', 'gcal-week-empty'));
    const scroll = new St.ScrollView({style_class: 'gcal-week-scroll',
        hscrollbar_policy: St.PolicyType.NEVER, vscrollbar_policy: St.PolicyType.AUTOMATIC});
    scroll.add_actor(list);
    column.add(scroll, {expand: true});
    return column;
}

// context: {days, itemsByDay, today, sizes, formatWeekday, actions}
function buildWeekView(context) {
    const row = new St.BoxLayout({style: `spacing: ${context.sizes.gridGap}px;`});
    for (const day of context.days)
        row.add_actor(weekColumn(day, context.itemsByDay.get(day), context));
    return row;
}

module.exports = {buildMonthView, buildWeekView, makeLabel, CENTERED};
