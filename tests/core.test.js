import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    emptyDay, buildLayout, computeStats, hourLabel, slotStart, planEvents, dueAlerts, buildIcs,
    fitnessTotal, toTemplate, addDays,
} from '../core.js';

const START = 21;

// 이미지(2026.11.15) 의 하루를 그대로 재현한다
function sampleDay() {
    const day = emptyDay();
    const set = (hour, patch) => Object.assign(day.rows[hour], patch);
    set(21, { cat: 'LIFE', action: '가족 시간', plan: '육아', done: true });
    set(22, { cat: 'LIFE', action: '수면', plan: '수면', done: true });
    [23, 0, 1, 2].forEach((h) => set(h, { catMerge: true, actMerge: true, planMerge: true, done: true }));
    set(3, { cat: 'LIFE', action: '분유', plan: '육아(운동)' });
    set(4, { cat: 'LIFE', action: '운동 / 독서', plan: '육아(독서)', done: true });
    set(5, { cat: 'LIFE', action: '안마', plan: '육아(업무)', done: true });
    set(6, { cat: 'ACTIVE', set: true, action: 'brochure', done: true });
    set(7, { catMerge: true, actMerge: true, planMerge: false, done: true });
    set(8, { action: '운동 / 샤워', plan: '운동 / 샤워', done: true });
    set(9, { cat: 'ACTIVE', set: true, action: 'Mobility V1', plan: '업무', done: true });
    set(10, { catMerge: true, actMerge: true, planMerge: true, done: true });
    set(11, { cat: 'LIFE', action: 'To-go', plan: '아침식사', done: true });
    set(12, { catMerge: true, action: 'TV', plan: '가족시간', done: true });
    set(13, { cat: 'ACTIVE', set: true, action: 'Mobility V2', plan: '업무', done: true });
    set(14, { catMerge: true, actMerge: true, planMerge: true, done: true });
    set(15, { cat: 'LIFE', action: '보드게임', plan: '가족시간', done: true });
    set(16, { catMerge: true, actMerge: true, planMerge: true, done: true });
    set(17, { cat: 'LIFE', action: '스타필드', plan: '업무' });
    set(18, { catMerge: true, actMerge: true, planMerge: true });
    set(19, { cat: 'LIFE', action: '씻기기', plan: '씻기기', done: true });
    set(20, { cat: 'LIFE', action: '가족 독서', plan: '독서', done: true });
    return day;
}

test('hourLabel: 자정은 AM 12, 정오는 PM 12', () => {
    assert.equal(hourLabel(0), 'AM 12:00');
    assert.equal(hourLabel(12), 'PM 12:00');
    assert.equal(hourLabel(21), 'PM 9:00');
});

test('이미지의 요약 수치를 그대로 재현한다', () => {
    const stats = computeStats(buildLayout(sampleDay().rows, START));
    assert.equal(stats.done, 21);
    assert.equal(stats.total, 24);
    assert.equal(stats.percent, 88);
    assert.equal(stats.sets, 3);
    assert.deepEqual(stats.hours, { BOOK: 0, ENGLISH: 0, ACTIVE: 6, PASSIVE: 0, LIFE: 17 });
});

test('병합 블록: span 과 유효값을 첫 행에서 물려받는다', () => {
    const layout = buildLayout(sampleDay().rows, START);
    const at = (h) => layout.find((it) => it.hour === h);
    assert.equal(at(22).catSpan, 5);
    assert.equal(at(23).catSpan, 0);
    assert.equal(at(1).action, '수면');
    assert.equal(at(6).setNo, 1);
    assert.equal(at(6).setSpan, 2);
    assert.equal(at(13).setNo, 3);
    // 6시는 PLAN 이 있고 7시는 병합 안 함 → 각각 1칸
    assert.equal(at(7).planSpan, 1);
    // 분류만 합치고 ACTION 은 따로인 블록
    assert.equal(at(11).catSpan, 2);
    assert.equal(at(12).actionSpan, 1);
});

test('ACTION 블록은 모든 칸이 완료되어야 취소선', () => {
    const layout = buildLayout(sampleDay().rows, START);
    assert.equal(layout.find((it) => it.hour === 22).actionDone, true);
    assert.equal(layout.find((it) => it.hour === 17).actionDone, false);
});

test('첫 표시 행의 병합 플래그는 무시된다', () => {
    const day = emptyDay();
    day.rows[START].catMerge = true;
    day.rows[START].cat = 'BOOK';
    const first = buildLayout(day.rows, START)[0];
    assert.equal(first.catSpan, 1);
    assert.equal(first.cat, 'BOOK');
});

test('SET 은 분류가 있는 블록에서만 성립한다', () => {
    const day = emptyDay();
    day.rows[9].set = true;
    assert.equal(computeStats(buildLayout(day.rows, START)).sets, 0);
});

test('빈 하루는 0% (0으로 나누지 않는다)', () => {
    const stats = computeStats(buildLayout(emptyDay().rows, START));
    assert.equal(stats.percent, 0);
    assert.equal(stats.total, 0);
});

test('slotStart: 오후 시작이면 시작 이후 칸은 전날 밤', () => {
    assert.equal(slotStart('2026-11-15', 21, 21).getDate(), 14);
    assert.equal(slotStart('2026-11-15', 3, 21).getDate(), 15);
    assert.equal(slotStart('2026-11-15', 20, 21).getDate(), 15);
});

test('slotStart: 오전 시작이면 시작 이전 칸은 다음날 새벽', () => {
    assert.equal(slotStart('2026-11-15', 2, 5).getDate(), 16);
    assert.equal(slotStart('2026-11-15', 5, 5).getDate(), 15);
    assert.equal(slotStart('2026-11-15', 2, 0).getDate(), 15);
});

test('addDays: 월말을 넘긴다', () => {
    assert.equal(addDays('2026-11-30', 1), '2026-12-01');
});

test('planEvents: 병합 블록당 일정 하나, 길이는 블록 길이', () => {
    const layout = buildLayout(sampleDay().rows, START);
    const events = planEvents('2026-11-15', layout, START);
    const sleep = events.find((e) => e.hour === 22);
    assert.equal(sleep.spanHours, 5);
    assert.equal(events.some((e) => e.hour === 23), false);
    // 6시 ACTION 블록(2칸), 7시는 PLAN 이 비어 있어 일정 없음
    assert.equal(events.find((e) => e.hour === 6).spanHours, 2);
    assert.equal(events.some((e) => e.hour === 7), false);
});

test('dueAlerts: 구간 경계와 리드타임, 완료한 칸 제외', () => {
    const layout = buildLayout(sampleDay().rows, START);
    const events = planEvents('2026-11-15', layout, START);
    const at17 = new Date(2026, 10, 15, 17).getTime();
    const lead = 10;
    const fire = at17 - lead * 60_000;
    assert.deepEqual(dueAlerts(events, lead, fire - 1, fire).map((e) => e.hour), [17]);
    assert.deepEqual(dueAlerts(events, lead, fire, fire + 1000), []);
    const at9 = new Date(2026, 10, 15, 9).getTime();
    assert.deepEqual(dueAlerts(events, 0, at9 - 1, at9), [], '완료한 칸은 알리지 않는다');
});

test('buildIcs: 알람과 이스케이프', () => {
    const day = emptyDay();
    day.rows[9] = { ...day.rows[9], action: '회의; A, B', cat: 'ACTIVE' };
    const events = planEvents('2026-11-16', buildLayout(day.rows, 0), 0);
    const ics = buildIcs(events, 5, new Date(Date.UTC(2026, 10, 16)));
    assert.match(ics, /DTSTART:20261116T090000/);
    assert.match(ics, /DTEND:20261116T100000/);
    assert.match(ics, /TRIGGER:-PT5M/);
    assert.match(ics, /SUMMARY:회의\\; A\\, B/);
    assert.ok(ics.includes('\r\n'));
});

test('템플릿은 완료 여부를 가져오지 않는다', () => {
    const day = sampleDay();
    const next = emptyDay(toTemplate(day.rows));
    assert.equal(next.rows[22].action, '수면');
    assert.equal(next.rows.some((r) => r.done), false);
});

test('fitnessTotal: 빈 칸·문자 무시', () => {
    assert.equal(fitnessTotal(['15', '10', '', 'x', '7.5']), 32.5);
});
