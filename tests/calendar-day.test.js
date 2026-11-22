import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarForDay, eventsInSlot } from '../core.js';

// 테스트는 로컬 시간대에서 돈다 → 기대값도 로컬 Date 로 만든다
const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();
const timed = (title, start, end) => ({ title, allDay: false, start, end });

test('여러 시간에 걸친 일정은 걸친 칸마다 표시, 끝 시각 칸은 제외 — 11/28 수영 7~9시 사례', () => {
    const events = [timed('수영', at(2026, 11, 28, 7), at(2026, 11, 28, 9))];
    const { byHour } = calendarForDay(events, '2026-11-28', 21);
    assert.deepEqual(byHour[7].map((e) => [e.title, e.continued]), [['수영', false]]);
    assert.deepEqual(byHour[8].map((e) => [e.title, e.continued]), [['수영', true]]);
    assert.equal(byHour[9], undefined);
});

test('정각이 아닌 시작: 9:30~10:30 은 9시(시작)와 10시(이어짐)', () => {
    const events = [timed('회의', at(2026, 11, 23, 9, 30), at(2026, 11, 23, 10, 30))];
    const { byHour } = calendarForDay(events, '2026-11-23', 21);
    assert.equal(byHour[9][0].continued, false);
    assert.equal(byHour[10][0].continued, true);
});

test('일정은 시작하는 칸에 놓이고, 하루 시작(PM 9) 전날 밤 일정도 이 날짜에 속한다', () => {
    const events = [
        timed('회의', at(2026, 11, 23, 9, 30), at(2026, 11, 23, 10, 30)),
        timed('전날 밤', at(2026, 11, 22, 22), at(2026, 11, 22, 23)),
        timed('다음 페이지', at(2026, 11, 23, 21), at(2026, 11, 23, 22)),
    ];
    const { byHour } = calendarForDay(events, '2026-11-23', 21);
    assert.deepEqual(byHour[9].map((e) => e.title), ['회의']);
    assert.deepEqual(byHour[22].map((e) => e.title), ['전날 밤']);
    assert.equal(byHour[21], undefined, '23일 PM 9시는 24일 페이지');
});

test('하루 시작 전에 시작해 걸쳐 있는 일정은 첫 칸에 continued 로', () => {
    const events = [timed('밤샘', at(2026, 11, 22, 20), at(2026, 11, 22, 23))];
    const { byHour } = calendarForDay(events, '2026-11-23', 21);
    assert.equal(byHour[21][0].continued, true);
});

test('종일 일정: end 미포함', () => {
    const events = [{ title: '휴가', allDay: true, start: '2026-11-23', end: '2026-11-25' }];
    assert.equal(calendarForDay(events, '2026-11-24', 21).allDay.length, 1);
    assert.equal(calendarForDay(events, '2026-11-25', 21).allDay.length, 0);
});

test('eventsInSlot: 칸과 겹치는 일정 (경계는 미포함)', () => {
    const events = [
        timed('9:30~10:30', at(2026, 11, 23, 9, 30), at(2026, 11, 23, 10, 30)),
        timed('8~9', at(2026, 11, 23, 8), at(2026, 11, 23, 9)),
    ];
    assert.deepEqual(eventsInSlot(events, '2026-11-23', 10, 21).map((e) => e.title), ['9:30~10:30']);
    assert.deepEqual(eventsInSlot(events, '2026-11-23', 9, 21).map((e) => e.title), ['9:30~10:30']);
});

test('일정이 없거나 null 이어도 안전', () => {
    assert.deepEqual(calendarForDay(null, '2026-11-23', 21), { byHour: {}, allDay: [] });
});

import { emptyDay, buildLayout, planColumn } from '../core.js';

function dayLayout(patch, startHour = 6) {
    const d = emptyDay();
    Object.entries(patch).forEach(([h, p]) => Object.assign(d.rows[h], p));
    return buildLayout(d.rows, startHour);
}
const cellAt = (layout, cells, hour) => cells[layout.findIndex((it) => it.hour === hour)];

test('빈 칸은 캘린더 일정 시간만큼 블록이 된다 (8~13시 → 8시부터 5칸)', () => {
    const layout = dayLayout({});
    const { byHour } = calendarForDay([timed('카카오 패밀리데이', at(2026, 11, 22, 8), at(2026, 11, 22, 13))], '2026-11-22', 6);
    const cells = planColumn(layout, byHour);
    const c8 = cellAt(layout, cells, 8);
    assert.deepEqual([c8.kind, c8.span, c8.event.title], ['cal', 5, '카카오 패밀리데이']);
    assert.equal(cellAt(layout, cells, 9).kind, 'skip');
    assert.equal(cellAt(layout, cells, 13).kind, 'user');
});

test('사용자 PLAN 은 덮어쓰지 않는다 — 11/22 실제 상황(9~12시 패밀리데이 참석)', () => {
    const layout = dayLayout({
        9: { plan: '패밀리데이 참석' }, 10: { planMerge: true }, 11: { planMerge: true }, 12: { planMerge: true },
    });
    const { byHour } = calendarForDay([timed('카카오 패밀리데이', at(2026, 11, 22, 8), at(2026, 11, 22, 13))], '2026-11-22', 6);
    const cells = planColumn(layout, byHour);
    assert.deepEqual([cellAt(layout, cells, 8).kind, cellAt(layout, cells, 8).span], ['cal', 1]);
    const c9 = cellAt(layout, cells, 9);
    assert.deepEqual([c9.kind, c9.span, c9.chips.map((e) => e.title)], ['user', 4, ['카카오 패밀리데이']]);
});

test('일정이 사용자 PLAN 에 끊기면 뒤쪽 빈 칸에 다시 블록', () => {
    const layout = dayLayout({ 9: { plan: '내 계획' } });
    const { byHour } = calendarForDay([timed('긴 일정', at(2026, 11, 22, 8), at(2026, 11, 22, 11))], '2026-11-22', 6);
    const cells = planColumn(layout, byHour);
    assert.deepEqual([cellAt(layout, cells, 8).kind, cellAt(layout, cells, 8).span], ['cal', 1]);
    assert.deepEqual([cellAt(layout, cells, 10).kind, cellAt(layout, cells, 10).span, cellAt(layout, cells, 10).event.continued], ['cal', 1, true]);
});

test('겹치는 일정: 먼저 시작한 일정이 블록, 나머지는 그 안에 작게', () => {
    const layout = dayLayout({});
    const { byHour } = calendarForDay([
        timed('회의', at(2026, 11, 22, 14), at(2026, 11, 22, 16)),
        timed('통화', at(2026, 11, 22, 15), at(2026, 11, 22, 15, 30)),
    ], '2026-11-22', 6);
    const cells = planColumn(layout, byHour);
    const c14 = cellAt(layout, cells, 14);
    assert.deepEqual([c14.kind, c14.span, c14.event.title, c14.chips.map((e) => e.title)], ['cal', 2, '회의', ['통화']]);
});

test('캘린더 일정이 없으면 사용자 칸 그대로', () => {
    const layout = dayLayout({ 9: { plan: 'A' }, 10: { planMerge: true } });
    const cells = planColumn(layout, {});
    assert.equal(cells.filter((c) => c.kind === 'cal').length, 0);
    assert.equal(cellAt(layout, cells, 9).span, 2);
});
