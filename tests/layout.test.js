const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('../gcal-month-week@danielvazdar/layout.js');

const MONDAY = 1;
const SUNDAY = 0;

test('November 2026 with Monday start spans 26 Oct to 6 Dec in 6 weeks', () => {
    const weeks = layout.monthWeeks(2026, 11, MONDAY);
    assert.equal(weeks.length, 6);
    assert.equal(weeks[0][0], '2026-10-26');
    assert.equal(weeks.at(-1).at(-1), '2026-12-06');
});

test('February 2027 starting on a Monday needs only 4 weeks', () => {
    assert.equal(layout.monthWeeks(2027, 2, MONDAY).length, 4);
});

test('Sunday week start shifts the grid', () => {
    assert.equal(layout.monthWeeks(2026, 11, SUNDAY)[0][0], '2026-11-01');
});

test('week of a Thursday runs Monday to Sunday', () => {
    assert.deepEqual(layout.weekDays('2026-11-26', MONDAY),
        ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29']);
});

test('adding days across the DST change keeps whole days', () => {
    assert.equal(layout.addDays('2026-10-24', 2), '2026-10-26');
});

test('items are placed on every day they cover, sorted like Google', () => {
    const items = [
        {kind: 'event', title: 'Lunch', allDay: false, startDate: '2026-11-26', endDate: '2026-11-26', startTime: '13:00'},
        {kind: 'event', title: 'Standup', allDay: false, startDate: '2026-11-26', endDate: '2026-11-26', startTime: '09:00'},
        {kind: 'task', title: 'Pay VAT', allDay: true, startDate: '2026-11-26', endDate: '2026-11-26', done: false},
        {kind: 'event', title: 'Trip', allDay: true, startDate: '2026-11-25', endDate: '2026-11-27'},
    ];
    const byDay = layout.itemsByDay(items, ['2026-11-25', '2026-11-26', '2026-11-28']);
    assert.deepEqual(byDay.get('2026-11-26').map(item => item.title), ['Trip', 'Pay VAT', 'Standup', 'Lunch']);
    assert.deepEqual(byDay.get('2026-11-25').map(item => item.title), ['Trip']);
    assert.deepEqual(byDay.get('2026-11-28'), []);
});

test('a timed event continuing past midnight shows as all-day without a time', () => {
    const overnight = {kind: 'event', title: 'Party', allDay: false, startDate: '2026-11-26',
        endDate: '2026-11-27', startTime: '22:00'};
    const byDay = layout.itemsByDay([overnight], ['2026-11-26', '2026-11-27']);
    assert.equal(byDay.get('2026-11-26')[0].startTime, '22:00');
    assert.deepEqual([byDay.get('2026-11-27')[0].allDay, byDay.get('2026-11-27')[0].startTime], [true, '']);
    assert.equal(overnight.allDay, false, 'input items are not mutated');
});

test('done tasks sort after open ones', () => {
    const tasks = [
        {kind: 'task', title: 'A', allDay: true, startDate: '2026-11-26', endDate: '2026-11-26', done: true},
        {kind: 'task', title: 'B', allDay: true, startDate: '2026-11-26', endDate: '2026-11-26', done: false},
    ];
    assert.deepEqual(layout.itemsByDay(tasks, ['2026-11-26']).get('2026-11-26').map(t => t.title), ['B', 'A']);
});

test('chip text is dark on light colours and white on dark ones', () => {
    assert.equal(layout.textColorOn('#f6bf26'), '#1f1f1f');
    assert.equal(layout.textColorOn('#3f51b5'), '#ffffff');
});

const SIZES = layout.sizesFor({width: 1000, height: 1100, fontSize: 14, lineHeight: 20, averageCharWidth: 8}, 6);

function timed(title, startTime = '09:00') {
    return {kind: 'event', title, allDay: false, startDate: '2026-11-26', endDate: '2026-11-26', startTime};
}

test('the grid fills the desklet without spilling over', () => {
    const gridWidth = SIZES.cellWidth * 7 + SIZES.gridGap * 6;
    assert.ok(gridWidth <= SIZES.rootContentWidth && gridWidth > SIZES.rootContentWidth - 7);
    const gridHeight = SIZES.weekdayRowHeight + 6 * (SIZES.gridGap + SIZES.cellHeight);
    assert.ok(gridHeight <= SIZES.bodyHeight && gridHeight > SIZES.bodyHeight - 6);
});

test('short titles take one line, long titles two', () => {
    const plan = layout.planCell([timed('Gym'), timed('Security review with the client')], SIZES);
    assert.deepEqual(plan.chips.map(chip => chip.lines), [1, 2]);
    assert.equal(plan.hiddenCount, 0);
});

function usedHeight(plan, extraRows = 0) {
    const rows = plan.chips.map(chip => layout.chipHeight(SIZES, chip.lines) + SIZES.chipGap);
    return rows.reduce((sum, row) => sum + row, 0) + extraRows * (layout.chipHeight(SIZES, 1) + SIZES.chipGap);
}

test('a full day keeps room for "+N more" and never overflows the cell', () => {
    const busyDay = Array.from({length: 12}, (_, index) => timed(`Meeting number ${index} with a long name`));
    const plan = layout.planCell(busyDay, SIZES);
    assert.ok(plan.hiddenCount > 0);
    assert.equal(plan.chips.length + plan.hiddenCount, 12);
    assert.ok(usedHeight(plan, 1) <= SIZES.chipSpace, 'chips + "+N more" fit in the cell');
});

test('a chip that cannot fit on two lines falls back to one', () => {
    const tight = {...SIZES, chipSpace: layout.chipHeight(SIZES, 1) + SIZES.chipGap};
    const plan = layout.planCell([timed('A very long title that wants two lines')], tight);
    assert.deepEqual(plan.chips.map(chip => chip.lines), [1]);
});

test('a tiny cell shows nothing rather than overflowing', () => {
    const plan = layout.planCell([timed('Gym')], {...SIZES, chipSpace: 3});
    assert.deepEqual([plan.chips.length, plan.hiddenCount], [0, 1]);
});

test('measured text sizes drive the line height and characters per line', () => {
    const measured = layout.sizesFor({width: 1000, height: 1100, fontSize: 14, lineHeight: 24, averageCharWidth: 10}, 6);
    const guessed = layout.sizesFor({width: 1000, height: 1100, fontSize: 14}, 6);
    assert.equal(measured.lineHeight, 24);
    assert.ok(measured.charsPerChipLine < guessed.charsPerChipLine);
});

test('the same holiday from two calendars is shown once', () => {
    const holiday = {kind: 'event', title: "All Saints' Day", allDay: true, startDate: '2026-11-01', endDate: '2026-11-01'};
    const items = [holiday, {...holiday, color: '#0b8043'}, {...holiday, title: "All Souls' Day"}];
    assert.deepEqual(layout.withoutDuplicates(items).map(item => item.title), ["All Saints' Day", "All Souls' Day"]);
});

test('times drop the leading zero', () => {
    assert.deepEqual(['09:00', '10:30', '00:15'].map(layout.shortTime), ['9:00', '10:30', '0:15']);
});
