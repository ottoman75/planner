import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDay, dayHasData, migrateTimestamps, toSyncPayload, mergeStates } from '../core.js';

function makeState(patch = {}) {
    return {
        settings: { title: 'P', startHour: 21, notify: { enabled: false, lead: 0 } },
        habits: [{ id: 'h1', name: '기상' }],
        exercises: [],
        template: null,
        metaUpdatedAt: 0,
        days: {},
        ...patch,
    };
}

function dayWith(action, updatedAt) {
    const d = emptyDay();
    d.rows[23].action = action;
    if (updatedAt !== undefined) d.updatedAt = updatedAt;
    return d;
}

test('dayHasData: 빈 날과 내용 있는 날 구분', () => {
    assert.equal(dayHasData(emptyDay()), false);
    assert.equal(dayHasData(dayWith('수면')), true);
    const d = emptyDay();
    d.note.idea = '아이디어';
    assert.equal(dayHasData(d), true);
});

test('migrate: 내용 있는 옛 기록만 시각 1, 빈 날은 0 유지', () => {
    const s = migrateTimestamps(makeState({ days: { a: dayWith('수면'), b: emptyDay() } }));
    assert.equal(s.days.a.updatedAt, 1);
    assert.equal(s.days.b.updatedAt, undefined);
});

test('폰의 옛 기록(1)이 맥에서 열어만 본 빈 날(0)을 이긴다 — 실제로 겪은 상황', () => {
    const phone = migrateTimestamps(makeState({ days: { '2026-11-17': dayWith('수면') } }));
    const mac = makeState({ days: { '2026-11-17': emptyDay() } });
    const merged = mergeStates(mac, toSyncPayload(phone));
    assert.equal(merged.days['2026-11-17'].rows[23].action, '수면');
});

test('열어만 본 빈 날은 원격에 올라가지 않는다', () => {
    const s = makeState({ days: { a: emptyDay(), b: dayWith('x', 5) } });
    assert.deepEqual(Object.keys(toSyncPayload(s).days), ['b']);
});

test('날짜별로 더 최근에 고친 쪽이 남는다 (양방향)', () => {
    const local = makeState({ days: { a: dayWith('로컬', 200), b: dayWith('로컬', 100) } });
    const remote = makeState({ days: { a: dayWith('원격', 150), b: dayWith('원격', 300), c: dayWith('원격', 10) } });
    const m = mergeStates(local, remote);
    assert.equal(m.days.a.rows[23].action, '로컬');
    assert.equal(m.days.b.rows[23].action, '원격');
    assert.equal(m.days.c.rows[23].action, '원격');
});

test('알림 설정은 기기별로 유지, 올리지도 않는다', () => {
    const local = makeState({ settings: { title: 'L', startHour: 21, notify: { enabled: true, lead: 10 } }, metaUpdatedAt: 1 });
    const remote = makeState({ settings: { title: 'R', startHour: 5, notify: { enabled: false, lead: 0 } }, metaUpdatedAt: 9 });
    const m = mergeStates(local, remote);
    assert.deepEqual(m.settings, { title: 'R', startHour: 5, notify: { enabled: true, lead: 10 } });
    assert.equal('notify' in toSyncPayload(local).settings, false);
});

test('공통 설정: 시각이 같으면 원격의 습관 목록(id)을 물려받는다', () => {
    const local = makeState({ habits: [{ id: 'mac', name: '기상' }] });
    const remote = makeState({ habits: [{ id: 'phone', name: '기상' }] });
    assert.equal(mergeStates(local, remote).habits[0].id, 'phone');
    const newer = makeState({ habits: [{ id: 'mac', name: '기상' }], metaUpdatedAt: 5 });
    assert.equal(mergeStates(newer, remote).habits[0].id, 'mac');
});

test('원격이 없으면(첫 연결) 로컬 그대로', () => {
    const local = makeState();
    assert.equal(mergeStates(local, null), local);
});

test('운동 프로그램 설정도 공통 설정으로 동기화, 옛 원격엔 없으면 로컬 유지', () => {
    const local = makeState({ program: { startDate: '2026-11-16' } });
    assert.deepEqual(toSyncPayload(local).program, { startDate: '2026-11-16' });
    const oldRemote = makeState();
    assert.deepEqual(mergeStates(local, oldRemote).program, { startDate: '2026-11-16' });
    const newer = makeState({ program: { startDate: '2026-11-23' }, metaUpdatedAt: 9 });
    assert.deepEqual(mergeStates(local, newer).program, { startDate: '2026-11-23' });
    const off = makeState({ program: null, metaUpdatedAt: 9 });
    assert.equal(mergeStates(local, off).program, null);
});
