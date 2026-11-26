// Pure date and layout logic for the desklet. No GJS imports, so Node can test it.
// Days are 'YYYY-MM-DD' strings; arithmetic runs in UTC so DST never shifts a day.

const DAYS_IN_WEEK = 7;
const MS_PER_DAY = 86400000;
const KIND_ORDER = {allDayEvent: 0, task: 1, timedEvent: 2};

function parseDay(day) {
    const [year, month, date] = day.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, date));
}

function formatDay(utcDate) {
    return utcDate.toISOString().slice(0, 10);
}

function addDays(day, count) {
    return formatDay(new Date(parseDay(day).getTime() + count * MS_PER_DAY));
}

function weekdayOf(day) {
    return parseDay(day).getUTCDay();
}

function startOfWeek(day, weekStart) {
    return addDays(day, -((weekdayOf(day) - weekStart + DAYS_IN_WEEK) % DAYS_IN_WEEK));
}

function weekDays(anyDayInWeek, weekStart) {
    const first = startOfWeek(anyDayInWeek, weekStart);
    return Array.from({length: DAYS_IN_WEEK}, (_, index) => addDays(first, index));
}

// The weeks that cover a month (4 to 6), each a list of 7 days.
function monthWeeks(year, month, weekStart) {
    const firstOfMonth = formatDay(new Date(Date.UTC(year, month - 1, 1)));
    const lastOfMonth = formatDay(new Date(Date.UTC(year, month, 0)));
    const weeks = [];
    for (let weekFirst = startOfWeek(firstOfMonth, weekStart); weekFirst <= lastOfMonth;
        weekFirst = addDays(weekFirst, DAYS_IN_WEEK)) {
        weeks.push(weekDays(weekFirst, weekStart));
    }
    return weeks;
}

function sortGroup(item) {
    if (item.kind === 'task')
        return KIND_ORDER.task;
    return item.allDay ? KIND_ORDER.allDayEvent : KIND_ORDER.timedEvent;
}

function compareItems(left, right) {
    return sortGroup(left) - sortGroup(right)
        || Number(Boolean(left.done)) - Number(Boolean(right.done))
        || (left.startTime || '').localeCompare(right.startTime || '')
        || left.title.localeCompare(right.title);
}

// For each day, the items that touch it, sorted the way Google lists them.
// A timed event continuing from an earlier day is shown like an all-day item.
function itemsByDay(items, days) {
    const byDay = new Map(days.map(day => [day, []]));
    for (const item of items) {
        for (const day of days) {
            if (day < item.startDate || day > item.endDate)
                continue;
            const continuesFromEarlierDay = day > item.startDate;
            byDay.get(day).push({
                ...item,
                allDay: item.allDay || continuesFromEarlierDay,
                startTime: continuesFromEarlierDay ? '' : item.startTime || '',
            });
        }
    }
    for (const dayItems of byDay.values())
        dayItems.sort(compareItems);
    return byDay;
}

// The same event in two selected calendars (e.g. two holiday calendars) is shown once.
function withoutDuplicates(items) {
    const seen = new Set();
    return items.filter(item => {
        const key = [item.kind, item.title, item.startDate, item.endDate, item.allDay, item.startTime || ''].join('|');
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}

// "09:00" -> "9:00": shorter, and how Google shows times.
function shortTime(time) {
    return time.replace(/^0(\d)/, '$1');
}

// Pixel sizes for the whole desklet, derived from the user's size and text-size settings.
// Every size the views use comes from here, so the "what fits" maths matches what is drawn.
// St sizes are content-box (padding and border come on top of a CSS width), hence the *Content values.
// lineHeight and averageCharWidth are measured on screen (theme font, text scaling); the fallbacks
// only cover the first draw before the desklet is on the stage.
function sizesFor({width, height, fontSize, lineHeight = 0, averageCharWidth = 0}, weekCount) {
    const outerPadding = 18;
    const rootBorder = 1;
    const gridGap = 4;
    const cellPadding = 5;
    const cellBorder = 1;
    const chipGap = 2;
    const chipBorder = 1;
    const chipBarWidth = 3;
    const chipBarGap = 5;
    const chipPaddingX = 5;
    const chipPaddingY = Math.max(2, Math.round(fontSize * 0.15));
    const textLineHeight = lineHeight || Math.ceil(fontSize * 1.45);
    const charWidth = averageCharWidth || fontSize * 0.6;
    const dayPillPaddingY = 2;
    const dayPillPaddingX = 5;
    const dayPillSize = textLineHeight + 2 * dayPillPaddingY;
    const dayNumberHeight = dayPillSize + 4;
    const headerHeight = Math.round(textLineHeight * 2.2);
    const weekdayRowHeight = Math.round(textLineHeight * 1.4);
    const rootContentWidth = width - 2 * (outerPadding + rootBorder);
    const rootContentHeight = height - 2 * (outerPadding + rootBorder);
    const bodyHeight = rootContentHeight - headerHeight;
    const cellInset = cellPadding + cellBorder;
    const cellWidth = Math.floor((rootContentWidth - gridGap * (DAYS_IN_WEEK - 1)) / DAYS_IN_WEEK);
    const cellHeight = Math.floor((bodyHeight - weekdayRowHeight - gridGap * weekCount) / weekCount);
    const cellContentWidth = cellWidth - 2 * cellInset;
    const chipTextWidth = cellContentWidth - 2 * (chipBorder + chipPaddingX) - chipBarWidth - chipBarGap;
    return {
        outerPadding, gridGap, cellPadding, chipGap, chipBorder, chipBarWidth, chipBarGap, chipPaddingX, chipPaddingY,
        lineHeight: textLineHeight, dayPillPaddingX, dayPillPaddingY, dayPillSize,
        headerHeight, weekdayRowHeight, dayNumberHeight, rootContentWidth, rootContentHeight,
        bodyHeight, cellInset, cellWidth, cellHeight, cellContentWidth,
        cellContentHeight: cellHeight - 2 * cellInset,
        weekColumnContentHeight: bodyHeight - 2 * cellInset,
        chipSpace: cellHeight - 2 * cellInset - dayNumberHeight,
        charsPerChipLine: Math.max(1, Math.floor(chipTextWidth / charWidth)),
    };
}

function chipHeight(sizes, lines) {
    return lines * sizes.lineHeight + 2 * (sizes.chipPaddingY + sizes.chipBorder);
}

// Characters a chip shows: "9:00 " before timed events, a checkbox mark before tasks.
function chipTextLength(item) {
    const timePrefix = item.startTime ? shortTime(item.startTime).length + 1 : 0;
    const taskPrefix = item.kind === 'task' ? 2 : 0;
    return timePrefix + taskPrefix + item.title.length;
}

// Which items a month cell shows and on how many lines (1 or 2), keeping room for "+N more".
function planCell(dayItems, sizes) {
    const rowCost = lines => chipHeight(sizes, lines) + sizes.chipGap;
    const budget = sizes.chipSpace;
    const chips = [];
    let used = 0;
    for (let index = 0; index < dayItems.length; index++) {
        const item = dayItems[index];
        const reserveForMore = index < dayItems.length - 1 ? rowCost(1) : 0;
        const wantedLines = chipTextLength(item) > sizes.charsPerChipLine ? 2 : 1;
        const lines = [wantedLines, 1].find(count => used + rowCost(count) + reserveForMore <= budget);
        if (!lines)
            break;
        used += rowCost(lines);
        chips.push({item, lines});
    }
    return {chips, hiddenCount: dayItems.length - chips.length};
}

// Dark or light text for a chip filled with this colour (WCAG relative luminance).
function textColorOn(hexColor) {
    const channels = hexColor.replace('#', '').match(/../g).map(pair => parseInt(pair, 16) / 255);
    const [red, green, blue] = channels.map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    return luminance > 0.4 ? '#1f1f1f' : '#ffffff';
}

module.exports = {addDays, weekDays, monthWeeks, itemsByDay, withoutDuplicates, shortTime, sizesFor,
    chipHeight, planCell, textColorOn};
