import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIcs, expandEvents, zonedToUtc, normalizeCalendarUrl } from '../calendar-ics.js';

const TZ = 'Asia/Seoul';
const ics = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:개인\r\n${body}\r\nEND:VCALENDAR\r\n`;
const ev = (lines) => `BEGIN:VEVENT\r\n${lines.join('\r\n')}\r\nEND:VEVENT`;
const range = (from, to) => [Date.parse(from), Date.parse(to)];
const expand = (text, from, to) => {
    const { events } = parseIcs(text, TZ);
    return expandEvents(events, ...range(from, to), '개인');
};

test('zonedToUtc: 서울(+9), 뉴욕 서머타임 전후', () => {
    assert.equal(new Date(zonedToUtc({ y: 2026, m: 11, d: 23, h: 9 }, TZ)).toISOString(), '2026-11-23T00:00:00.000Z');
    assert.equal(new Date(zonedToUtc({ y: 2026, m: 7, d: 1, h: 9 }, 'America/New_York')).toISOString(), '2026-07-01T13:00:00.000Z');
    assert.equal(new Date(zonedToUtc({ y: 2026, m: 12, d: 1, h: 9 }, 'America/New_York')).toISOString(), '2026-12-01T14:00:00.000Z');
});

test('단일 일정: TZID, 접힌 줄, 이스케이프, 알람 블록 무시', () => {
    const text = ics(ev([
        'UID:a1', 'DTSTART;TZID=Asia/Seoul:20261123T093000', 'DTEND;TZID=Asia/Seoul:20261123T103000',
        'SUMMARY:팀 회의\\, 주간', ' 보고', 'LOCATION:회의실 A',
        'BEGIN:VALARM', 'TRIGGER:-PT10M', 'DESCRIPTION:알람 제목', 'END:VALARM',
    ]));
    const [e] = expand(text, '2026-11-20T00:00:00Z', '2026-11-30T00:00:00Z');
    assert.equal(e.title, '팀 회의, 주간보고');
    assert.equal(e.location, '회의실 A');
    assert.equal(e.start, '2026-11-23T00:30:00.000Z');
    assert.equal(e.end, '2026-11-23T01:30:00.000Z');
    assert.equal(e.calendar, '개인');
    assert.equal(parseIcs(text, TZ).name, '개인');
});

test('UTC(Z) 와 floating(기본 시간대) 시각', () => {
    const text = ics([
        ev(['UID:z', 'DTSTART:20261123T000000Z', 'DURATION:PT1H', 'SUMMARY:UTC']),
        ev(['UID:f', 'DTSTART:20261123T090000', 'DTEND:20261123T100000', 'SUMMARY:floating']),
    ].join('\r\n'));
    const out = expand(text, '2026-11-22T00:00:00Z', '2026-11-24T00:00:00Z');
    assert.deepEqual(out.map((e) => [e.title, e.start]), [
        ['UTC', '2026-11-23T00:00:00.000Z'], ['floating', '2026-11-23T00:00:00.000Z'],
    ]);
});

test('종일 일정: 날짜 문자열, end 는 다음 날', () => {
    const text = ics(ev(['UID:d', 'DTSTART;VALUE=DATE:20261125', 'DTEND;VALUE=DATE:20261127', 'SUMMARY:휴가']));
    const [e] = expand(text, '2026-11-20T00:00:00Z', '2026-11-30T00:00:00Z');
    assert.deepEqual([e.allDay, e.start, e.end], [true, '2026-11-25', '2026-11-27']);
});

test('주간 반복 BYDAY + EXDATE + 수정된 회차(RECURRENCE-ID)', () => {
    const text = ics([
        ev(['UID:w', 'DTSTART;TZID=Asia/Seoul:20261102T080000', 'DTEND;TZID=Asia/Seoul:20261102T090000',
            'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'EXDATE;TZID=Asia/Seoul:20261125T080000', 'SUMMARY:수영']),
        ev(['UID:w', 'RECURRENCE-ID;TZID=Asia/Seoul:20261123T080000',
            'DTSTART;TZID=Asia/Seoul:20261123T190000', 'DTEND;TZID=Asia/Seoul:20261123T200000', 'SUMMARY:수영(저녁)']),
    ].join('\r\n'));
    const out = expand(text, '2026-11-22T15:00:00Z', '2026-11-29T15:00:00Z'); // 서울 11/23~11/29
    assert.deepEqual(out.map((e) => [e.title, e.start]), [
        ['수영(저녁)', '2026-11-23T10:00:00.000Z'],
    ], '23일 아침 회차는 저녁으로 옮겨졌고, 25일은 제외됨');
});

test('COUNT 는 창 밖 회차도 센다, UNTIL 이후는 없음', () => {
    const text = ics([
        ev(['UID:c', 'DTSTART;TZID=Asia/Seoul:20261101T070000', 'RRULE:FREQ=DAILY;COUNT=25', 'SUMMARY:카운트']),
        ev(['UID:u', 'DTSTART;TZID=Asia/Seoul:20261120T070000', 'RRULE:FREQ=DAILY;UNTIL=20261123T000000Z', 'SUMMARY:언틸']),
    ].join('\r\n'));
    const out = expand(text, '2026-11-20T00:00:00Z', '2026-12-31T00:00:00Z');
    const days = (t) => out.filter((e) => e.title === t).map((e) => e.start.slice(0, 10));
    assert.deepEqual(days('카운트'), ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24']);
    // 서울 11/20 07:00 = 11/19 22:00Z 는 창 시작 전, 11/23 07:00(=22일 22:00Z)은 UNTIL 이전이라 포함
    assert.deepEqual(days('언틸'), ['2026-11-20', '2026-11-21', '2026-11-22']);
});

test('월간: 마지막 금요일, 31일은 없는 달 건너뜀', () => {
    const text = ics([
        ev(['UID:m1', 'DTSTART;TZID=Asia/Seoul:20261030T180000', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'SUMMARY:월말 회고']),
        ev(['UID:m2', 'DTSTART;VALUE=DATE:20261031', 'RRULE:FREQ=MONTHLY', 'SUMMARY:정산']),
    ].join('\r\n'));
    const out = expand(text, '2026-11-01T00:00:00Z', '2027-02-01T00:00:00Z');
    assert.deepEqual(out.filter((e) => e.title === '월말 회고').map((e) => e.start.slice(0, 10)),
        ['2026-11-27', '2026-12-25', '2027-01-29']);
    assert.deepEqual(out.filter((e) => e.title === '정산').map((e) => e.start), ['2026-12-31', '2027-01-31']);
});

test('오래전에 시작한 매일 반복도 창 안에서 나온다', () => {
    const text = ics(ev(['UID:old', 'DTSTART;TZID=Asia/Seoul:20100101T060000', 'RRULE:FREQ=DAILY', 'SUMMARY:기상']));
    const out = expand(text, '2026-11-22T15:00:00Z', '2026-11-24T15:00:00Z');
    assert.deepEqual(out.map((e) => e.start), ['2026-11-22T21:00:00.000Z', '2026-11-23T21:00:00.000Z']);
});

test('취소된 일정 제외', () => {
    const text = ics(ev(['UID:x', 'DTSTART:20261123T000000Z', 'STATUS:CANCELLED', 'SUMMARY:취소']));
    assert.deepEqual(expand(text, '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'), []);
});

test('webcal 링크를 https 로', () => {
    assert.equal(normalizeCalendarUrl(' webcal://p01-caldav.icloud.com/published/2/abc '), 'https://p01-caldav.icloud.com/published/2/abc');
});
