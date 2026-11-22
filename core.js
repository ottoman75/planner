// 플래너 도메인 로직 — DOM에 의존하지 않는 순수 함수만 둔다 (node --test 로 검증)

export const CATEGORY_IDS = ['BOOK', 'ENGLISH', 'ACTIVE', 'PASSIVE', 'LIFE'];
export const HOURS_PER_DAY = 24;
export const FITNESS_SETS = 10;
export const PRIORITY_MAX = 3;
export const WEEKDAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];

const MS_PER_MINUTE = 60_000;
const NOON = 12;

// [유효값 필드, "위 칸과 합치기" 플래그]
const MERGE_FIELDS = [
    ['cat', 'catMerge'],
    ['action', 'actMerge'],
    ['plan', 'planMerge'],
];

export function emptyRow() {
    return {
        cat: '',
        action: '',
        plan: '',
        done: false,
        pri: 0,
        catMerge: false,
        actMerge: false,
        planMerge: false,
        set: false,
    };
}

// 템플릿은 시간(0~23)별 행 배열. 완료 여부는 가져오지 않는다
export function emptyDay(template) {
    const rows = Array.from({ length: HOURS_PER_DAY }, (_, hour) => {
        const base = template?.[hour];
        return base ? { ...emptyRow(), ...base, done: false } : emptyRow();
    });
    return {
        rows,
        habitsDone: {},
        fitness: {},
        meta: { sleep: '', weight: '' },
        note: { keyword: '', idea: '', etc: '' },
    };
}

// 행 → 템플릿으로 저장할 필드만 남긴다
export function toTemplate(rows) {
    return rows.map(({ done, ...rest }) => ({ ...rest }));
}

export function displayHours(startHour) {
    return Array.from({ length: HOURS_PER_DAY }, (_, i) => (startHour + i) % HOURS_PER_DAY);
}

export function hourLabel(hour) {
    const meridiem = hour < NOON ? 'AM' : 'PM';
    const h12 = hour % NOON === 0 ? NOON : hour % NOON;
    return `${meridiem} ${h12}:00`;
}

/**
 * 표시 순서대로 각 행의 병합 정보와 유효값을 계산한다.
 * - xxxSpan: 블록 첫 행이면 블록 길이, 블록에 덮인 행이면 0
 * - xxxHead: 블록 첫 행의 hour
 * - cat/action/plan: 블록 첫 행에서 물려받은 유효값
 * - setNo/setSpan: SET 은 분류 블록 단위로 지정된다
 */
export function buildLayout(rows, startHour) {
    const items = displayHours(startHour).map((hour, index) => ({ hour, index, row: rows[hour] }));

    for (const [field, flag] of MERGE_FIELDS) {
        let head = null;
        items.forEach((item, i) => {
            if (i > 0 && item.row[flag] && head) {
                head[`${field}Span`] += 1;
                item[`${field}Span`] = 0;
                item[`${field}Head`] = head.hour;
                item[field] = head.row[field];
            } else {
                head = item;
                item[`${field}Span`] = 1;
                item[`${field}Head`] = item.hour;
                item[field] = item.row[field];
            }
        });
    }

    const byHour = new Map(items.map((item) => [item.hour, item]));
    let setCount = 0;
    items.forEach((item) => {
        const head = byHour.get(item.catHead);
        const isSet = Boolean(head.row.set && head.cat);
        if (isSet && item === head) setCount += 1;
        item.setNo = isSet ? setCount : 0;
        item.setSpan = isSet && item === head ? item.catSpan : 0;
    });

    // ACTION 블록 전체가 완료되면 취소선
    items.forEach((item, i) => {
        item.actionDone = item.actionSpan > 0
            && items.slice(i, i + item.actionSpan).every((it) => it.row.done);
    });

    return items;
}

export function hasContent(item) {
    return Boolean(item.cat || item.action.trim() || item.plan.trim());
}

export function computeStats(layout) {
    const counted = layout.filter((item) => hasContent(item) || item.row.done);
    const done = counted.filter((item) => item.row.done).length;
    const total = counted.length;
    const hours = Object.fromEntries(CATEGORY_IDS.map((id) => [id, 0]));
    layout.forEach((item) => {
        if (item.cat in hours) hours[item.cat] += 1;
    });
    return {
        done,
        total,
        percent: total ? Math.round((done / total) * 100) : 0,
        hours,
        sets: layout.filter((item) => item.setSpan > 0).length,
    };
}

// ---- 날짜 ----

export function toKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

export function parseKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d);
}

export function addDays(key, n) {
    const date = parseKey(key);
    date.setDate(date.getDate() + n);
    return toKey(date);
}

/**
 * 플래너 하루가 자정에 시작하지 않을 때 실제 시각을 구한다.
 * - 시작 시각이 오후(예: 21시)면 시작 시각 이후 칸은 "전날 밤"
 * - 시작 시각이 오전(예: 4시)이면 시작 시각 이전 칸은 "다음날 새벽"
 */
export function slotStart(dayKey, hour, startHour) {
    let key = dayKey;
    if (startHour >= NOON && hour >= startHour) key = addDays(dayKey, -1);
    else if (startHour > 0 && startHour < NOON && hour < startHour) key = addDays(dayKey, 1);
    const date = parseKey(key);
    date.setHours(hour, 0, 0, 0);
    return date;
}

// ---- 알림 / 캘린더 ----

// ACTION 또는 PLAN 블록이 시작되는 칸마다 하나의 일정
export function planEvents(dayKey, layout, startHour) {
    return layout
        .filter((item) => (item.actionSpan > 0 && item.action.trim()) || (item.planSpan > 0 && item.plan.trim()))
        .map((item) => {
            const actionHead = item.actionSpan > 0 && item.action.trim();
            return {
                dayKey,
                hour: item.hour,
                start: slotStart(dayKey, item.hour, startHour),
                spanHours: actionHead ? item.actionSpan : item.planSpan,
                cat: item.cat,
                action: item.action.trim(),
                plan: item.plan.trim(),
                done: item.row.done,
            };
        });
}

export function eventTitle(event) {
    return event.action || event.plan;
}

export function eventBody(event) {
    const parts = [hourLabel(event.hour)];
    if (event.cat) parts.push(event.cat);
    if (event.action && event.plan) parts.push(`PLAN: ${event.plan}`);
    return parts.join(' · ');
}

// (fromMs, toMs] 구간에 울려야 하는 알림. 이미 완료한 칸은 제외
export function dueAlerts(events, leadMinutes, fromMs, toMs) {
    return events.filter((event) => {
        if (event.done) return false;
        const fireAt = event.start.getTime() - leadMinutes * MS_PER_MINUTE;
        return fireAt > fromMs && fireAt <= toMs;
    });
}

function icsDate(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}00`;
}

function icsUtc(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function icsText(text) {
    return text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
}

// 캘린더 앱에 넣으면 앱이 꺼져 있어도 알림이 온다 (floating local time)
export function buildIcs(events, leadMinutes, now = new Date()) {
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Planner//KO', 'CALSCALE:GREGORIAN'];
    events.forEach((event) => {
        const end = new Date(event.start.getTime() + event.spanHours * 60 * MS_PER_MINUTE);
        lines.push(
            'BEGIN:VEVENT',
            `UID:${event.dayKey}-${event.hour}@planner`,
            `DTSTAMP:${icsUtc(now)}`,
            `DTSTART:${icsDate(event.start)}`,
            `DTEND:${icsDate(end)}`,
            `SUMMARY:${icsText(eventTitle(event))}`,
            `DESCRIPTION:${icsText(eventBody(event))}`,
            'BEGIN:VALARM',
            'ACTION:DISPLAY',
            `DESCRIPTION:${icsText(eventTitle(event))}`,
            `TRIGGER:-PT${leadMinutes}M`,
            'END:VALARM',
            'END:VEVENT',
        );
    });
    lines.push('END:VCALENDAR');
    return `${lines.join('\r\n')}\r\n`;
}

export function fitnessTotal(values = []) {
    return values.reduce((sum, v) => sum + (Number.parseFloat(v) || 0), 0);
}

// ---- 기기 간 동기화 ----
// 병합 단위: 날짜별 하루 기록(updatedAt) + 공통 설정 묶음(metaUpdatedAt).
// 같은 날을 두 기기에서 동시에 고치면 나중에 고친 쪽의 하루 전체가 남는다.

export function dayHasData(d) {
    if (!d) return false;
    const rowData = d.rows?.some((r) => r.cat || r.action || r.plan || r.done || r.pri);
    const fitData = Object.values(d.fitness ?? {}).some((vals) => vals.some((v) => String(v ?? '').trim()));
    return Boolean(rowData || fitData
        || Object.values(d.habitsDone ?? {}).some(Boolean)
        || Object.values(d.note ?? {}).some((v) => v?.trim())
        || Object.values(d.meta ?? {}).some((v) => String(v ?? '').trim()));
}

// 동기화 도입 전 기록에는 시각이 없다. 내용이 있으면 가장 오래된 시각(1)을 줘서
// 빈 날(0)보다는 이기고, 이후 실제로 고친 기록에는 지게 한다
export function migrateTimestamps(state) {
    Object.values(state.days ?? {}).forEach((d) => {
        if (!d.updatedAt && dayHasData(d)) d.updatedAt = 1;
    });
    return state;
}

// 원격에 올릴 내용. 알림 설정은 기기마다 권한이 달라 올리지 않는다
export function toSyncPayload(state) {
    const { notify, ...settings } = state.settings;
    const days = Object.fromEntries(Object.entries(state.days).filter(([, d]) => d.updatedAt > 0));
    return {
        version: 1,
        metaUpdatedAt: state.metaUpdatedAt ?? 0,
        settings,
        habits: state.habits,
        exercises: state.exercises,
        template: state.template ?? null,
        program: state.program ?? null,
        days,
    };
}

// 공통 설정은 시각이 같으면 원격을 따른다 (새 기기가 기존 습관 id 를 물려받도록)
export function mergeStates(local, remote) {
    if (!remote) return local;
    const days = { ...local.days };
    Object.entries(remote.days ?? {}).forEach(([key, r]) => {
        const l = days[key];
        if (!l || (r.updatedAt ?? 0) >= (l.updatedAt ?? 0)) days[key] = r;
    });
    const localMeta = local.metaUpdatedAt ?? 0;
    const remoteMeta = remote.metaUpdatedAt ?? 0;
    const src = localMeta > remoteMeta ? local : remote;
    const { notify: _ignored, ...srcSettings } = src.settings ?? {};
    return {
        ...local,
        settings: { ...local.settings, ...srcSettings, notify: local.settings.notify },
        habits: src.habits ?? local.habits,
        exercises: src.exercises ?? local.exercises,
        template: src.template ?? null,
        // 프로그램 도입 전 기기가 올린 원격에는 program 이 없다 → 로컬 유지
        program: src.program !== undefined ? src.program : (local.program ?? null),
        metaUpdatedAt: Math.max(localMeta, remoteMeta),
        days,
    };
}

// ---- 아이폰 캘린더 일정 (읽기 전용 표시) ----
// events: calendar-ics.js 의 expandEvents 결과. 시간 일정은 UTC ISO, 종일은 'YYYY-MM-DD'

const HOUR_MS = 60 * MS_PER_MINUTE;

/**
 * 플래너 하루(첫 표시 칸부터 24시간)에 걸치는 일정을 칸에 배치한다
 * - byHour[h]: 그 칸(1시간)과 겹치는 일정. 끝 시각 칸은 미포함(7~9시 → 7시·8시 칸)
 *   그 칸보다 먼저 시작한 일정은 continued=true (화면에서 "↳ 이어짐")
 * - allDay: 이 날짜를 포함하는 종일 일정
 */
export function calendarForDay(events, dayKey, startHour) {
    const slots = displayHours(startHour).map((hour) => ({ hour, from: slotStart(dayKey, hour, startHour).getTime() }));
    const byHour = {};
    const allDay = [];
    (events ?? []).forEach((e) => {
        if (e.allDay) {
            if (e.start <= dayKey && e.end > dayKey) allDay.push(e);
            return;
        }
        const startMs = Date.parse(e.start);
        const endMs = Math.max(Date.parse(e.end), startMs + 1);
        slots.forEach(({ hour, from }) => {
            if (startMs >= from + HOUR_MS || endMs <= from) return;
            (byHour[hour] ??= []).push({ ...e, startMs, endMs, continued: startMs < from });
        });
    });
    return { byHour, allDay };
}

// 한 칸(1시간)과 겹치는 시간 일정
export function eventsInSlot(events, dayKey, hour, startHour) {
    const from = slotStart(dayKey, hour, startHour).getTime();
    const to = from + HOUR_MS;
    return (events ?? []).filter((e) => !e.allDay && Date.parse(e.start) < to && Math.max(Date.parse(e.end), Date.parse(e.start) + 1) > from);
}

export function clockLabel(ms) {
    const d = new Date(ms);
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function calendarEventKey(e) {
    return `${e.uid}|${e.start}`;
}

/**
 * PLAN 열 구성 — 사용자 PLAN 은 그대로, 비어 있는 칸만 캘린더 일정 블록으로 채운다 (저장하지 않는 표시용)
 * 반환: 표시 행마다
 *  - { kind: 'user', span, chips }           사용자 PLAN 칸 (span 은 합치기 반영)
 *  - { kind: 'cal', span, event, chips }      캘린더 일정 블록 (연속된 빈 칸을 합침)
 *  - { kind: 'skip' }                         위 칸 블록에 덮인 행
 * chips: 그 칸과 겹치지만 블록의 주인이 아닌 일정 (중복 제거)
 * 일정이 겹치면 먼저 시작한(같으면 긴) 일정이 빈 칸을 차지한다
 */
export function planColumn(layout, byHour) {
    const n = layout.length;
    const free = layout.map((it) => it.planSpan === 1 && !it.plan.trim());
    const found = new Map();
    layout.forEach((it, i) => (byHour[it.hour] ?? []).forEach((e) => {
        const key = calendarEventKey(e);
        if (!found.has(key)) found.set(key, { key, first: e, rows: [] });
        found.get(key).rows.push(i);
    }));
    const ordered = [...found.values()].sort((a, b) => (a.first.startMs - b.first.startMs)
        || (b.first.endMs - b.first.startMs) - (a.first.endMs - a.first.startMs));

    const owner = new Array(n).fill(null);
    ordered.forEach(({ key, rows }) => rows.forEach((i) => {
        if (free[i] && owner[i] === null) owner[i] = key;
    }));

    const chipsFor = (from, span, exceptKey) => {
        const seen = new Set([exceptKey]);
        return layout.slice(from, from + span).flatMap((it) => byHour[it.hour] ?? []).filter((e) => {
            const key = calendarEventKey(e);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    };

    const cells = new Array(n).fill(null).map(() => ({ kind: 'skip' }));
    let i = 0;
    while (i < n) {
        if (owner[i]) {
            let j = i;
            while (j + 1 < n && owner[j + 1] === owner[i]) j += 1;
            const span = j - i + 1;
            const event = (byHour[layout[i].hour] ?? []).find((e) => calendarEventKey(e) === owner[i]);
            cells[i] = { kind: 'cal', span, event, chips: chipsFor(i, span, owner[i]) };
            i = j + 1;
        } else {
            const span = Math.max(layout[i].planSpan, 1);
            cells[i] = { kind: 'user', span, chips: chipsFor(i, span, null) };
            i += span;
        }
    }
    return cells;
}
