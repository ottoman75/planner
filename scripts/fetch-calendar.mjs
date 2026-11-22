// GitHub Actions 에서 30분마다 실행: 플래너 설정의 캘린더 링크(.ics) → 일정 펼치기 → 비공개 Gist 의 planner-calendar.json
// ⚠️ 공개 저장소의 실행 로그는 누구나 볼 수 있다. 링크·일정 제목을 절대 출력하지 않는다
import { parseIcs, expandEvents, normalizeCalendarUrl } from '../calendar-ics.js';

// Actions 가 자동으로 넣어 주는 값. 로컬 검증 때는 목 서버 주소로 바꿀 수 있다
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
const DATA_FILE = 'planner-data.json';
const CALENDAR_FILE = 'planner-calendar.json';
const DEFAULT_TZ = 'Asia/Seoul';
const DAY_MS = 86_400_000;
const PAST_DAYS = 14;
const FUTURE_DAYS = 90;
const MAX_EVENTS = 3000;
const REFRESH_MS = 6 * 60 * 60_000; // 변경이 없어도 6시간마다는 기록해 "살아 있음"을 보여준다
const FETCH_TIMEOUT_MS = 20_000;
const LIST_PAGES = 3;

const token = process.env.PLANNER_GIST_TOKEN;
if (!token) {
    console.log('PLANNER_GIST_TOKEN 시크릿이 없어 건너뜁니다.');
    process.exit(0);
}

async function gh(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
        ...options,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'planner-calendar' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    return res.json();
}

async function fileText(file) {
    if (!file) return null;
    if (!file.truncated) return file.content;
    const res = await fetch(file.raw_url);
    return res.ok ? res.text() : null;
}

async function findGist() {
    for (let page = 1; page <= LIST_PAGES; page += 1) {
        const list = await gh(`/gists?per_page=100&page=${page}`);
        const hit = list.find((g) => g.files?.[DATA_FILE]);
        if (hit) return hit.id;
        if (list.length < 100) break;
    }
    return null;
}

async function fetchCalendar(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(normalizeCalendarUrl(url), { signal: controller.signal, headers: { 'User-Agent': 'planner-calendar' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.includes('BEGIN:VCALENDAR')) throw new Error('캘린더 형식이 아님');
        return text;
    } catch (err) {
        throw new Error(err.name === 'AbortError' ? '응답 시간 초과' : err.message);
    } finally {
        clearTimeout(timer);
    }
}

// 비교용: fetchedAt 을 뺀 내용
const comparable = (payload) => JSON.stringify({ events: payload?.events, errors: payload?.errors, calendars: payload?.calendars });

const gistId = await findGist();
if (!gistId) {
    console.log('동기화 Gist 가 아직 없어 건너뜁니다. (플래너에서 동기화를 먼저 연결)');
    process.exit(0);
}
const gist = await gh(`/gists/${gistId}`);
const data = JSON.parse((await fileText(gist.files[DATA_FILE])) ?? '{}');
const urls = (data.settings?.calendarUrls ?? []).filter((u) => typeof u === 'string' && u.trim());
const previous = JSON.parse((await fileText(gist.files[CALENDAR_FILE])) ?? 'null');

if (!urls.length && !previous) {
    console.log('등록된 캘린더 링크가 없어 건너뜁니다.');
    process.exit(0);
}

const now = Date.now();
const from = now - PAST_DAYS * DAY_MS;
const to = now + FUTURE_DAYS * DAY_MS;
const events = [];
const errors = [];
const calendars = [];

for (const [i, url] of urls.entries()) {
    try {
        const { name, events: raw } = parseIcs(await fetchCalendar(url), DEFAULT_TZ);
        const label = name || `캘린더 ${i + 1}`;
        const expanded = expandEvents(raw, from, to, label);
        events.push(...expanded);
        calendars.push({ name: label, count: expanded.length });
    } catch (err) {
        errors.push(`캘린더 ${i + 1}: ${err.message}`);
    }
}
events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

const payload = { version: 1, fetchedAt: new Date(now).toISOString(), events: events.slice(0, MAX_EVENTS), errors, calendars };
const stale = !previous?.fetchedAt || now - Date.parse(previous.fetchedAt) > REFRESH_MS;
const changed = comparable(payload) !== comparable(previous);

if (changed || stale) {
    await gh(`/gists/${gistId}`, {
        method: 'PATCH',
        body: JSON.stringify({ files: { [CALENDAR_FILE]: { content: JSON.stringify(payload) } } }),
    });
}
console.log(`캘린더 ${urls.length}개 · 일정 ${payload.events.length}개 · 오류 ${errors.length}개 · ${changed ? '변경 반영' : stale ? '시각 갱신' : '변경 없음'}`);
