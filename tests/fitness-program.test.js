import { test } from 'node:test';
import assert from 'node:assert/strict';
import { programDay, programWeek, dayTypeOf, mondayOf, PROGRAM_WEEKS } from '../fitness-program.js';

const START = '2026-11-16'; // 월요일
const row = (day, key) => day.rows.find((r) => r.key === key);

test('요일 → 날 유형: 월수금 / 화목토 / 일', () => {
    assert.deepEqual([1, 3, 5].map(dayTypeOf), [0, 0, 0]);
    assert.deepEqual([2, 4, 6].map(dayTypeOf), [1, 1, 1]);
    assert.equal(dayTypeOf(0), 2);
});

test('주차: 시작일 0주차, 8주 지나면 null, 시작 전 null', () => {
    assert.equal(programWeek(START, '2026-11-16'), 0);
    assert.equal(programWeek(START, '2026-11-22'), 0);
    assert.equal(programWeek(START, '2026-11-23'), 1);
    assert.equal(programWeek(START, '2027-01-10'), PROGRAM_WEEKS - 1);
    assert.equal(programWeek(START, '2027-01-11'), null);
    assert.equal(programWeek(START, '2026-11-15'), null);
});

test('mondayOf: 토요일 → 그 주 월요일, 일요일은 전 주 월요일', () => {
    assert.equal(mondayOf('2026-11-21'), '2026-11-16');
    assert.equal(mondayOf('2026-11-22'), '2026-11-16');
    assert.equal(mondayOf('2026-11-16'), '2026-11-16');
});

test('1주차 월요일: 원본 표와 같은 목표', () => {
    const d = programDay(START, '2026-11-16');
    assert.equal(d.stage, '적응');
    assert.equal(d.dayLabel, '월·수·금');
    assert.deepEqual([row(d, 'pg:pu').sets, row(d, 'pg:pu').rep, row(d, 'pg:pu').total], [5, 1, 5]);
    assert.equal(row(d, 'pg:neg').total, 9);
    assert.equal(row(d, 'pg:psh').total, 60);
    assert.deepEqual([row(d, 'pg:sq').rep, row(d, 'pg:sq').total], [20, 60]);
    assert.deepEqual([row(d, 'pg:yt').rep, row(d, 'pg:yt').total], [40, 80]);
    assert.equal(row(d, 'pg:ho').total, 80);
    assert.equal(row(d, 'pg:st').total, 10);
    assert.equal(row(d, 'pg:cardio').note, '수영');
    assert.match(d.tip, /3초/);
});

test('화목토: 네거티브 쉬고 준비운동 안내', () => {
    const d = programDay(START, '2026-11-21');
    assert.equal(row(d, 'pg:neg').sets, 0);
    assert.match(d.tip, /스캐퓰러 풀업 3×8회, 데드행 3×20초/);
});

test('일요일: 스트레칭 15분만', () => {
    const d = programDay(START, '2026-11-22');
    assert.equal(d.dayLabel, '일 (회복)');
    assert.equal(row(d, 'pg:st').total, 15);
    assert.equal(d.rows.filter((r) => r.sets > 0).length, 1);
});

test('7주차(고강도): 턱걸이 5×3, 천천히 스쿼트 안내', () => {
    const d = programDay(START, '2026-12-28');
    assert.equal(d.stage, '고강도');
    assert.equal(row(d, 'pg:pu').total, 15);
    assert.match(d.tip, /3초 동안 천천히/);
});

test('시작일 없음/기간 밖이면 null', () => {
    assert.equal(programDay(null, '2026-11-16'), null);
    assert.equal(programDay(START, '2027-02-01'), null);
});
