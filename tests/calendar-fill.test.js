import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    emptyDay, buildLayout, computeStats, applyCalendarToDay, claimCalendarRows, calendarEventKey,
    defaultCalendarCategory, CAL_FILL_OFF, toTemplate,
} from '../core.js';

const START = 6;
const KEY = '2026-11-23';
const at = (h, mi = 0) => new Date(2026, 10, 23, h, mi).toISOString();
const ev = (title, s, e, calendar = '가족 캘린더', uid = title) => ({ uid, title, calendar, allDay: false, start: s, end: e });
const byCalendar = (e) => defaultCalendarCategory(e.calendar);
const fill = (day, events, catFor = byCalendar) => applyCalendarToDay(day, events, KEY, START, catFor);
const view = (day, hour) => buildLayout(day.rows, START).find((it) => it.hour === hour);

test('빈 날: 8~13시 일정 → 분류·ACTION·PLAN 이 5칸 블록으로', () => {
    const day = emptyDay();
    assert.equal(fill(day, [ev('카카오 패밀리데이', at(8), at(13))]), true);
    const h8 = view(day, 8);
    assert.deepEqual([h8.cat, h8.action, h8.plan, h8.catSpan, h8.actionSpan, h8.planSpan],
        ['LIFE', '카카오 패밀리데이', '카카오 패밀리데이', 5, 5, 5]);
    assert.equal(view(day, 13).cat, '');
    assert.equal(computeStats(buildLayout(day.rows, START)).hours.LIFE, 5);
});

test('사용자가 적은 칸은 덮어쓰지 않는다 — 11/22 상황', () => {
    const day = emptyDay();
    Object.assign(day.rows[9], { cat: 'ACTIVE', action: '패밀리데이 참석', plan: '패밀리데이 참석' });
    [10, 11, 12].forEach((h) => Object.assign(day.rows[h], { catMerge: true, actMerge: true, planMerge: true }));
    fill(day, [ev('카카오 패밀리데이', at(8), at(13))]);
    assert.deepEqual([view(day, 8).action, view(day, 8).catSpan], ['카카오 패밀리데이', 1]);
    assert.deepEqual([view(day, 9).cat, view(day, 9).action, view(day, 9).catSpan], ['ACTIVE', '패밀리데이 참석', 4]);
});

test('캘린더 이름별 기본 분류, 채우지 않기', () => {
    assert.equal(defaultCalendarCategory('회사'), 'ACTIVE');
    assert.equal(defaultCalendarCategory('가족 캘린더'), 'LIFE');
    const day = emptyDay();
    fill(day, [ev('보고', at(9), at(10), '회사')]);
    assert.equal(view(day, 9).cat, 'ACTIVE');
    const off = emptyDay();
    assert.equal(fill(off, [ev('보고', at(9), at(10))], () => CAL_FILL_OFF), false);
});

test('일정이 옮겨지거나 지워지면 자동 채움도 따라간다', () => {
    const day = emptyDay();
    fill(day, [ev('수영', at(7), at(9))]);
    fill(day, [ev('수영', at(10), at(11))]);
    assert.equal(view(day, 7).action, '');
    assert.equal(view(day, 10).action, '수영');
    assert.equal(fill(day, []), true);
    assert.equal(day.rows.some((r) => r.action), false);
});

test('완료(✓)한 블록은 사용자 기록 — 일정이 지워져도 남는다', () => {
    const day = emptyDay();
    fill(day, [ev('수영', at(7), at(9))]);
    day.rows[8].done = true;
    fill(day, []);
    assert.deepEqual([view(day, 7).action, view(day, 7).catSpan], ['수영', 2]);
    assert.equal(day.rows.some((r) => r.cal), false);
});

test('사용자가 고친 블록(claim)은 그대로 남는다', () => {
    const day = emptyDay();
    const e = ev('수영', at(7), at(9));
    fill(day, [e]);
    day.rows[7].cat = 'ACTIVE';
    claimCalendarRows(day.rows, calendarEventKey(e));
    fill(day, []);
    assert.deepEqual([view(day, 7).cat, view(day, 7).catSpan], ['ACTIVE', 2]);
});

test('이 칸 비우기로 지운 일정은 다시 채우지 않는다', () => {
    const day = emptyDay();
    const e = ev('수영', at(7), at(9));
    fill(day, [e]);
    day.calDismissed = [calendarEventKey(e)];
    fill(day, [e]);
    assert.equal(day.rows.some((r) => r.action), false);
});

test('변화 없으면 false (매번 저장·동기화하지 않도록)', () => {
    const day = emptyDay();
    const events = [ev('수영', at(7), at(9))];
    fill(day, events);
    assert.equal(fill(day, events), false);
});

test('겹치는 일정: 먼저 시작한 일정이 칸을 차지, 남은 빈 칸은 뒤 일정', () => {
    const day = emptyDay();
    fill(day, [ev('회의', at(14), at(16)), ev('통화', at(15, 30), at(17))]);
    assert.deepEqual([view(day, 14).action, view(day, 14).catSpan], ['회의', 2]);
    assert.deepEqual([view(day, 16).action, view(day, 16).catSpan], ['통화', 1]);
});

test('기본 계획으로 저장할 때 자동 채움 표시는 빠진다', () => {
    const day = emptyDay();
    fill(day, [ev('수영', at(7), at(9))]);
    assert.equal(toTemplate(day.rows).some((r) => 'cal' in r), false);
});
