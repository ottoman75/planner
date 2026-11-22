// iCalendar(.ics) 해석 + 반복 일정 펼치기. GitHub Actions(node)와 테스트에서 쓴다. DOM 없음
// 지원: DTSTART/DTEND/DURATION, TZID·UTC·floating·종일, RRULE(DAILY/WEEKLY/MONTHLY/YEARLY,
//       INTERVAL, COUNT, UNTIL, BYDAY(서수 포함), BYMONTHDAY, BYMONTH), EXDATE, RECURRENCE-ID, STATUS:CANCELLED

const MS_MINUTE = 60_000;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;
const MAX_ITERATIONS = 5000;
const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

// ---------- 줄 / 속성 ----------

function unfold(text) {
    return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function parseLine(line) {
    const colon = findValueColon(line);
    if (colon < 0) return null;
    const [name, ...paramParts] = line.slice(0, colon).split(';');
    const params = {};
    paramParts.forEach((p) => {
        const eq = p.indexOf('=');
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    });
    return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

// 따옴표 안의 콜론(TZID="..:..")은 건너뛴다
function findValueColon(line) {
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        if (line[i] === '"') quoted = !quoted;
        else if (line[i] === ':' && !quoted) return i;
    }
    return -1;
}

function unescapeText(value) {
    return value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

// ---------- 시간 ----------

const offsetFormatters = new Map();

function zoneFormatter(tz) {
    if (!offsetFormatters.has(tz)) {
        offsetFormatters.set(tz, new Intl.DateTimeFormat('en-US', {
            timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit',
        }));
    }
    return offsetFormatters.get(tz);
}

export function isValidZone(tz) {
    try {
        zoneFormatter(tz);
        return true;
    } catch {
        return false;
    }
}

function zoneOffset(utcMs, tz) {
    const parts = Object.fromEntries(zoneFormatter(tz).formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// 해당 시간대의 벽시계 시각 → UTC ms (서머타임 전환 포함)
export function zonedToUtc({ y, m, d, h = 0, mi = 0, s = 0 }, tz) {
    const guess = Date.UTC(y, m - 1, d, h, mi, s);
    let utc = guess - zoneOffset(guess, tz);
    const second = guess - zoneOffset(utc, tz);
    if (second !== utc) utc = second;
    return utc;
}

/**
 * 날짜 값 → { allDay, wall:{y,m,d,h,mi,s}, tz }
 *  - 종일: VALUE=DATE 이거나 8자리
 *  - UTC: Z 로 끝남 → tz 'UTC'
 *  - TZID 가 있으면 그 시간대, 없으면 floating → 기본 시간대
 */
function parseDateValue(value, params, defaultTz) {
    const v = value.trim();
    const y = +v.slice(0, 4);
    const m = +v.slice(4, 6);
    const d = +v.slice(6, 8);
    if (params.VALUE === 'DATE' || v.length === 8) return { allDay: true, wall: { y, m, d }, tz: null };
    const wall = { y, m, d, h: +v.slice(9, 11), mi: +v.slice(11, 13), s: +v.slice(13, 15) || 0 };
    if (v.endsWith('Z')) return { allDay: false, wall, tz: 'UTC' };
    const tz = params.TZID && isValidZone(params.TZID) ? params.TZID : defaultTz;
    return { allDay: false, wall, tz };
}

function toInstant(dt) {
    return dt.allDay ? Date.UTC(dt.wall.y, dt.wall.m - 1, dt.wall.d) : zonedToUtc(dt.wall, dt.tz);
}

function parseDuration(value) {
    const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
    if (!match) return 0;
    const [, sign, w, d, h, mi, s] = match;
    const ms = ((+w || 0) * 7 + (+d || 0)) * MS_DAY + (+h || 0) * MS_HOUR + (+mi || 0) * MS_MINUTE + (+s || 0) * 1000;
    return sign === '-' ? -ms : ms;
}

// ---------- 날짜 계산 (벽시계 기준, UTC Date 로 요일·월말 계산) ----------

function dayIndex({ y, m, d }) {
    return Math.round(Date.UTC(y, m - 1, d) / MS_DAY);
}

function fromDayIndex(idx) {
    const date = new Date(idx * MS_DAY);
    return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function weekdayOf({ y, m, d }) {
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function parseByDay(list) {
    return (list ?? '').split(',').filter(Boolean).map((token) => {
        const match = /^([+-]?\d+)?([A-Z]{2})$/.exec(token.trim());
        return match ? { ord: match[1] ? Number(match[1]) : 0, wd: WEEKDAY_CODES.indexOf(match[2]) } : null;
    }).filter((x) => x && x.wd >= 0);
}

// 한 달 안에서 "n번째 요일" (음수는 뒤에서부터)
function nthWeekdayOfMonth(y, m, wd, ord) {
    const days = [];
    for (let d = 1; d <= daysInMonth(y, m); d += 1) if (weekdayOf({ y, m, d }) === wd) days.push(d);
    if (!ord) return days;
    const pick = ord > 0 ? days[ord - 1] : days[days.length + ord];
    return pick ? [pick] : [];
}

function monthDays(y, m, byMonthDay) {
    const last = daysInMonth(y, m);
    return byMonthDay.map((n) => (n > 0 ? n : last + n + 1)).filter((n) => n >= 1 && n <= last);
}

function parseRrule(value) {
    return Object.fromEntries(value.split(';').map((p) => p.split('=')).filter(([k, v]) => k && v)
        .map(([k, v]) => [k.toUpperCase(), v]));
}

/** 한 주기(period)에 들어가는 날짜 후보들 — 오름차순 */
function periodDates(rule, start, k) {
    const interval = Number(rule.INTERVAL) || 1;
    const byDay = parseByDay(rule.BYDAY);
    const byMonthDay = (rule.BYMONTHDAY ?? '').split(',').filter(Boolean).map(Number);
    const byMonth = (rule.BYMONTH ?? '').split(',').filter(Boolean).map(Number);

    switch (rule.FREQ) {
    case 'DAILY':
        return [fromDayIndex(dayIndex(start) + k * interval)];
    case 'WEEKLY': {
        // 주 시작은 월요일(WKST 기본값)
        const startIdx = dayIndex(start);
        const monday = startIdx - ((weekdayOf(start) + 6) % 7) + k * interval * 7;
        const wds = byDay.length ? byDay.map((b) => b.wd) : [weekdayOf(start)];
        return [...new Set(wds)].map((wd) => fromDayIndex(monday + ((wd + 6) % 7))).sort((a, b) => dayIndex(a) - dayIndex(b));
    }
    case 'MONTHLY': {
        const total = start.m - 1 + k * interval;
        const y = start.y + Math.floor(total / 12);
        const m = (total % 12) + 1;
        let days;
        if (byDay.length) days = byDay.flatMap((b) => nthWeekdayOfMonth(y, m, b.wd, b.ord));
        else days = monthDays(y, m, byMonthDay.length ? byMonthDay : [start.d]);
        return [...new Set(days)].sort((a, b) => a - b).map((d) => ({ y, m, d }));
    }
    case 'YEARLY': {
        const y = start.y + k * interval;
        const months = byMonth.length ? byMonth : [start.m];
        return months.flatMap((m) => {
            if (byDay.length) return byDay.flatMap((b) => nthWeekdayOfMonth(y, m, b.wd, b.ord)).map((d) => ({ y, m, d }));
            return monthDays(y, m, byMonthDay.length ? byMonthDay : [start.d]).map((d) => ({ y, m, d }));
        }).sort((a, b) => dayIndex(a) - dayIndex(b));
    }
    default:
        return [];
    }
}

// COUNT 가 없으면 회차 수를 셀 필요가 없으므로 창(window) 직전 주기까지 건너뛴다
function skipPeriods(rule, start, fromMs, count) {
    if (count !== Infinity) return 0;
    const interval = Number(rule.INTERVAL) || 1;
    const from = new Date(fromMs);
    const fromWall = { y: from.getUTCFullYear(), m: from.getUTCMonth() + 1, d: from.getUTCDate() };
    const daysApart = dayIndex(fromWall) - dayIndex(start);
    const monthsApart = (fromWall.y - start.y) * 12 + (fromWall.m - start.m);
    const periods = {
        DAILY: daysApart / interval,
        WEEKLY: daysApart / (7 * interval),
        MONTHLY: monthsApart / interval,
        YEARLY: (fromWall.y - start.y) / interval,
    }[rule.FREQ] ?? 0;
    // 시간대 차이로 하루 어긋날 수 있어 두 주기 여유를 둔다
    return Math.max(0, Math.floor(periods) - 2);
}

// ---------- 해석 ----------

/** .ics 텍스트 → { name, events:[원본 VEVENT] } */
export function parseIcs(text, defaultTz) {
    const events = [];
    let name = '';
    let current = null;
    let depth = 0; // VEVENT 안의 VALARM 등은 무시
    unfold(text).forEach((line) => {
        const prop = parseLine(line);
        if (!prop) return;
        if (prop.name === 'BEGIN') {
            if (prop.value === 'VEVENT' && !current) current = { exdates: [] };
            else if (current) depth += 1;
            return;
        }
        if (prop.name === 'END') {
            if (current && depth > 0) depth -= 1;
            else if (current && prop.value === 'VEVENT') {
                events.push(current);
                current = null;
            }
            return;
        }
        if (!current) {
            if (prop.name === 'X-WR-CALNAME') name = unescapeText(prop.value);
            return;
        }
        if (depth > 0) return;
        switch (prop.name) {
        case 'UID': current.uid = prop.value; break;
        case 'SUMMARY': current.title = unescapeText(prop.value); break;
        case 'LOCATION': current.location = unescapeText(prop.value); break;
        case 'STATUS': current.status = prop.value.toUpperCase(); break;
        case 'DTSTART': current.start = parseDateValue(prop.value, prop.params, defaultTz); break;
        case 'DTEND': current.end = parseDateValue(prop.value, prop.params, defaultTz); break;
        case 'DURATION': current.duration = parseDuration(prop.value); break;
        case 'RRULE': current.rrule = parseRrule(prop.value); break;
        case 'RECURRENCE-ID': current.recurrenceId = parseDateValue(prop.value, prop.params, defaultTz); break;
        case 'EXDATE':
            prop.value.split(',').forEach((v) => current.exdates.push(parseDateValue(v, prop.params, defaultTz)));
            break;
        default: break;
        }
    });
    return { name, events: events.filter((e) => e.start) };
}

function eventLength(ev) {
    if (ev.end) return Math.max(0, toInstant(ev.end) - toInstant(ev.start));
    if (ev.duration) return ev.duration;
    return ev.start.allDay ? MS_DAY : 0;
}

function isoDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

function output(ev, startMs, lengthMs, calendar) {
    const base = { uid: ev.uid ?? '', title: ev.title || '(제목 없음)', calendar };
    if (ev.location) base.location = ev.location;
    if (ev.start.allDay) return { ...base, allDay: true, start: isoDay(startMs), end: isoDay(startMs + Math.max(lengthMs, MS_DAY)) };
    return { ...base, allDay: false, start: new Date(startMs).toISOString(), end: new Date(startMs + lengthMs).toISOString() };
}

/**
 * 원본 VEVENT → [fromMs, toMs) 와 겹치는 실제 일정들
 * 반환: { uid, title, location?, calendar, allDay, start, end }
 *   - 시간 일정: start/end 는 UTC ISO 문자열
 *   - 종일 일정: start/end 는 'YYYY-MM-DD' (end 는 그 다음 날, 미포함)
 */
export function expandEvents(raw, fromMs, toMs, calendar = '') {
    const overrides = new Map();
    raw.filter((e) => e.recurrenceId).forEach((e) => {
        overrides.set(`${e.uid}|${toInstant(e.recurrenceId)}`, e);
    });
    const out = [];
    const overlaps = (s, len) => s < toMs && s + Math.max(len, 1) > fromMs;

    raw.forEach((ev) => {
        if (ev.status === 'CANCELLED') return;
        const len = eventLength(ev);
        if (ev.recurrenceId || !ev.rrule) {
            const s = toInstant(ev.start);
            if (overlaps(s, len)) out.push(output(ev, s, len, calendar));
            return;
        }
        const rule = ev.rrule;
        const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
        const until = rule.UNTIL ? toInstant(parseDateValue(rule.UNTIL, {}, 'UTC')) : Infinity;
        const exdates = new Set(ev.exdates.map(toInstant));
        const startWall = ev.start.wall;
        const firstInstant = toInstant(ev.start);
        let produced = 0;

        const firstPeriod = skipPeriods(rule, startWall, fromMs, count);
        for (let k = firstPeriod; k < firstPeriod + MAX_ITERATIONS && produced < count; k += 1) {
            const dates = periodDates(rule, startWall, k);
            if (!dates.length && rule.FREQ !== 'MONTHLY' && rule.FREQ !== 'YEARLY') break;
            let pastWindow = false;
            for (const date of dates) {
                const occ = { ...ev.start, wall: { ...startWall, ...date } };
                const s = toInstant(occ);
                if (s < firstInstant) continue;
                if (s > until || produced >= count) {
                    pastWindow = true;
                    break;
                }
                produced += 1;
                if (s >= toMs) {
                    pastWindow = true;
                    break;
                }
                if (exdates.has(s)) continue;
                const override = overrides.get(`${ev.uid}|${s}`);
                if (override) continue; // 수정된 회차는 별도 VEVENT 로 들어간다
                if (overlaps(s, len)) out.push(output(ev, s, len, calendar));
            }
            if (pastWindow) break;
        }
    });

    return out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}

// webcal:// → https:// (iCloud 공유 링크)
export function normalizeCalendarUrl(url) {
    return url.trim().replace(/^webcals?:\/\//i, 'https://');
}
