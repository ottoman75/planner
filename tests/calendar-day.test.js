import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarForDay, eventsInSlot } from '../core.js';

// 테스트는 로컬 시간대에서 돈다 → 기대값도 로컬 Date 로 만든다
const at = (y, m, d, h, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();
const timed = (title, start, end) => ({ title, allDay: false, start, end });

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
