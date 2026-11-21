// 8주 턱걸이 중심 프로그램 — 날짜 → 그날의 세트별 목표. DOM 에 의존하지 않는다
// 출처: 사용자가 준 fitness_tracker_set_targets_8weeks.html 의 표 값을 그대로 옮김

import { parseKey } from './core.js';

export const PROGRAM_WEEKS = 8;
const DAYS_PER_WEEK = 7;
const MS_PER_DAY = 86_400_000;
const SQUAT_SIDES = 2; // 스플릿 스쿼트는 양쪽 다리 합산
const YTW_MOVES = 4; // Y-T-W·외회전 4동작 합산

export const DAY_TYPE_LABELS = ['월·수·금', '화·목·토', '일 (회복)'];
const DAY_HEAVY = 0;
const DAY_LIGHT = 1;
const DAY_REST = 2;

const W = {
    stage: ['적응', '증량', '증량', '회복 + 토요일 재측정', '증량 (새 최대 기준)', '증량', '고강도', '회복 + 토요일 재측정'],
    pu: [[5, 1], [6, 1], [4, 2], [3, 1], [5, 2], [6, 2], [5, 3], [3, 2]],
    neg: [[3, 3, '3초'], [3, 3, '5초'], [4, 3, '5초'], [2, 3, '3초'], [3, 4, '5초'], [3, 4, '6~8초'], [3, 3, '8초'], [2, 3, '5초']],
    psh: [[4, 15], [4, 18], [4, 21], [3, 15], [4, 21], [5, 21], [4, 25], [3, 18]],
    sq: [[3, 10], [3, 12], [3, 14], [2, 10], [3, 12], [3, 14], [3, 15], [2, 10]],
    yt: [[2, 10], [3, 10], [3, 12], [2, 10], [3, 12], [3, 15], [3, 15], [2, 10]],
    ho: [[4, 20], [4, 25], [4, 30], [3, 20], [4, 30], [4, 35], [4, 40], [3, 25]],
    st: [10, 10, 10, 15, 10, 10, 10, 15],
    scap: [[3, 8, 20], [3, 10, 30], [3, 10, 40], [2, 8, 20], [3, 12, 40], [3, 12, 45], [3, 15, 60], [2, 10, 30]],
};
const REST_DAY_STRETCH_MIN = 15;
const SLOW_SQUAT_WEEKS = [4, 5, 6]; // 5~7주차

// 운동 기록 키는 사용자 운동 목록 id 와 겹치지 않도록 접두사를 붙인다
export const PROGRAM_EXERCISES = [
    { key: 'pg:pu', name: '턱걸이', unit: '회' },
    { key: 'pg:neg', name: '네거티브', unit: '회' },
    { key: 'pg:psh', name: '푸시업', unit: '회' },
    { key: 'pg:sq', name: '스플릿 스쿼트', unit: '회' },
    { key: 'pg:yt', name: 'Y-T-W·외회전', unit: '회' },
    { key: 'pg:ho', name: '할로우 홀드', unit: '초' },
    { key: 'pg:cardio', name: '유산소', unit: '분' },
    { key: 'pg:st', name: '스트레칭', unit: '분' },
];

export function dayTypeOf(weekday) {
    if (weekday === 0) return DAY_REST;
    return weekday % 2 === 1 ? DAY_HEAVY : DAY_LIGHT;
}

// 시작일 기준 몇 주차인지 (0부터). 범위 밖이면 null
export function programWeek(startKey, dayKey) {
    const diff = Math.round((parseKey(dayKey) - parseKey(startKey)) / MS_PER_DAY);
    if (diff < 0) return null;
    const week = Math.floor(diff / DAYS_PER_WEEK);
    return week < PROGRAM_WEEKS ? week : null;
}

// 이번 주 월요일 — 프로그램 시작일 기본값
export function mondayOf(dayKey) {
    const date = parseKey(dayKey);
    const back = (date.getDay() + DAYS_PER_WEEK - 1) % DAYS_PER_WEEK;
    date.setDate(date.getDate() - back);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function target(sets, rep) {
    return { sets, rep, total: sets * rep };
}

const REST = target(0, 0);

/**
 * 그날의 목표. 프로그램 기간 밖이면 null
 * rows[i] = { key, name, unit, sets, rep, total, note? }
 *  - sets 0 이면 그날은 쉬는 운동
 *  - note 가 있으면 숫자 목표 대신 안내 (유산소: 수영)
 */
export function programDay(startKey, dayKey) {
    if (!startKey) return null;
    const w = programWeek(startKey, dayKey);
    if (w === null) return null;
    const type = dayTypeOf(parseKey(dayKey).getDay());

    const targets = type === DAY_REST
        ? { 'pg:st': target(1, REST_DAY_STRETCH_MIN) }
        : {
            'pg:pu': target(...W.pu[w]),
            'pg:neg': type === DAY_HEAVY ? target(W.neg[w][0], W.neg[w][1]) : REST,
            'pg:psh': target(...W.psh[w]),
            'pg:sq': target(W.sq[w][0], W.sq[w][1] * SQUAT_SIDES),
            'pg:yt': target(W.yt[w][0], W.yt[w][1] * YTW_MOVES),
            'pg:ho': target(...W.ho[w]),
            'pg:st': target(1, W.st[w]),
        };
    const rows = PROGRAM_EXERCISES.map((ex) => {
        if (ex.key === 'pg:cardio') return { ...ex, ...REST, note: '수영' };
        return { ...ex, ...(targets[ex.key] ?? REST) };
    });

    return {
        week: w,
        stage: W.stage[w],
        dayType: type,
        dayLabel: DAY_TYPE_LABELS[type],
        rows,
        tip: tipFor(w, type),
    };
}

function tipFor(w, type) {
    if (type === DAY_REST) return '근력 운동은 쉬고 가벼운 수영과 스트레칭만 하세요.';
    const parts = [];
    if (type === DAY_HEAVY) parts.push(`네거티브는 내려오는 데 ${W.neg[w][2]} 걸리게 하세요.`);
    if (type === DAY_LIGHT) {
        const [sets, reps, hang] = W.scap[w];
        parts.push(`준비운동(기록 안 함): 스캐퓰러 풀업 ${sets}×${reps}회, 데드행 ${sets}×${hang}초.`);
    }
    parts.push('스플릿 스쿼트는 양쪽 다리를 합친 횟수, Y-T-W는 동작 4개를 합친 횟수예요.');
    if (SLOW_SQUAT_WEEKS.includes(w)) parts.push('스쿼트는 3초 동안 천천히 내려가세요.');
    parts.push('세트 사이 휴식: 턱걸이 2~3분, 나머지 60~90초.');
    return parts.join(' ');
}
