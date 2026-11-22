import {
    CATEGORY_IDS, FITNESS_SETS, PRIORITY_MAX, WEEKDAYS,
    emptyRow, emptyDay, toTemplate, displayHours, hourLabel, buildLayout, computeStats,
    toKey, parseKey, addDays, slotStart, planEvents, eventTitle, eventBody, dueAlerts, buildIcs, fitnessTotal,
    migrateTimestamps, toSyncPayload, mergeStates, calendarForDay, eventsInSlot, clockLabel, planColumn, calendarEventKey,
} from './core.js';
import { findGist, createGist, readGist, writeGist } from './sync.js';
import { programDay, mondayOf } from './fitness-program.js';

const STORE_KEY = 'planner.v1';
const TICK_KEY = 'planner.lastTick';
// 토큰은 백업 파일에 섞이지 않도록 별도 키에 둔다
const SYNC_KEY = 'planner.sync';
const SYNC_PUSH_DELAY_MS = 1500;
const SYNC_POLL_MS = 60_000;
// 아이폰 캘린더 일정(Gist 의 planner-calendar.json 사본). 읽기 전용이라 동기화·백업에 넣지 않는다
const CALENDAR_KEY = 'planner.calendar';
const CAL_CHIPS_MAX = 2;
const SAVE_DELAY_MS = 250;
const TICK_INTERVAL_MS = 15_000;
const MAX_CATCHUP_MS = 10 * 60_000;
const HOUR_MS = 60 * 60_000;
const TOAST_MS = 2800;
const RING_RADIUS = 42;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const LEAD_OPTIONS = [0, 5, 10, 15, 30];
const UNITS = ['회', '분', '초', 'kg', 'km', '세트'];
const ICS_WEEK_DAYS = 7;
const DEFAULT_START_HOUR = 21;

const ICONS = {
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    dumbbell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 7v10M3.5 9.5v5M17.5 7v10M20.5 9.5v5M6.5 12h11" stroke-linecap="round"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20l4-1 11-11-3-3L5 16l-1 4ZM14 7l3 3" stroke-linejoin="round"/></svg>',
};

const $ = (sel) => document.querySelector(sel);
const uid = () => Math.random().toString(36).slice(2, 10);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// ---------- 상태 ----------

function defaultState() {
    const habits = ['4시 기상', '기상 후 소금물', '회화 30분', '영양제 먹기', '오전 운동 30분', '독서 30분'];
    const exercises = [['턱걸이', '회'], ['덤벨프레스', '회'], ['유산소', '분'], ['스쿼트', '회'], ['윗몸일으키기', '회'], ['스트레칭', '분']];
    return {
        settings: {
            title: '4X 플래너',
            startHour: DEFAULT_START_HOUR,
            notify: { enabled: false, lead: 0 },
            calendarUrls: [],
        },
        habits: habits.map((name, i) => ({ id: `h${i + 1}`, name })),
        exercises: exercises.map(([name, unit], i) => ({ id: `e${i + 1}`, name, unit })),
        template: null,
        // 8주 운동 프로그램. null 이면 꺼짐
        program: { startDate: mondayOf(toKey(new Date())) },
        metaUpdatedAt: 0,
        days: {},
    };
}

function loadState() {
    const base = defaultState();
    try {
        const saved = JSON.parse(localStorage.getItem(STORE_KEY));
        if (!saved) return base;
        return migrateTimestamps({
            ...base,
            ...saved,
            settings: { ...base.settings, ...saved.settings, notify: { ...base.settings.notify, ...saved.settings?.notify } },
        });
    } catch {
        return base;
    }
}

let state = loadState();
let currentKey = toKey(new Date());
let editHabits = false;
let editFitness = false;
let saveTimer = null;

/**
 * scope — 무엇이 바뀌었는지 동기화에 알린다
 * - 'day': 보고 있는 날의 기록 (기본)
 * - 'meta': 습관·운동 목록, 플래너 이름, 시작 시각, 기본 계획
 * - 'none': 이 기기에만 해당 (알림 설정, 편집 모드 전환)
 */
function save(scope = 'day') {
    if (scope === 'day') day().updatedAt = Date.now();
    if (scope === 'meta') state.metaUpdatedAt = Date.now();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(state));
        } catch {
            toast('저장 공간이 부족해 저장하지 못했어요');
        }
    }, SAVE_DELAY_MS);
    if (scope !== 'none') schedulePush();
}

function day(key = currentKey) {
    if (!state.days[key]) state.days[key] = emptyDay(state.template);
    return state.days[key];
}

function layoutOf(key = currentKey) {
    return buildLayout(day(key).rows, state.settings.startHour);
}

function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), TOAST_MS);
}

function brandHtml(title) {
    return esc(title).replace(/(\d+X)/, '<b>$1</b>');
}

// ---------- 렌더링 ----------

function render() {
    renderHeader();
    renderBoard();
    renderFitness();
    renderHabits();
    renderNote();
}

function renderHeader() {
    const date = parseKey(currentKey);
    $('#dateText').textContent = currentKey.replaceAll('-', '.');
    const weekday = $('#weekday');
    weekday.textContent = WEEKDAYS[date.getDay()];
    weekday.classList.toggle('sun', date.getDay() === 0);
    $('#datePicker').value = currentKey;
    $('#brand').innerHTML = brandHtml(state.settings.title);
    $('#footBrand').innerHTML = brandHtml(state.settings.title);
    $('#todayBtn').hidden = currentKey === toKey(new Date());
    document.title = `${currentKey.replaceAll('-', '.')} · ${state.settings.title}`;
}

function renderBoard() {
    const layout = layoutOf();
    renderSummary(computeStats(layout));
    renderTable(layout);
}

function renderSummary(stats) {
    const offset = RING_CIRCUMFERENCE * (1 - stats.percent / 100);
    const cats = CATEGORY_IDS.map((id) => `
        <div class="cat-hour" data-cat="${id}">
            <span class="num">${stats.hours[id]}<small>h</small></span>
            <span class="name"><span class="dot"></span>${id}</span>
        </div>`).join('');
    $('#summary').innerHTML = `
        <div class="ring" role="img" aria-label="달성률 ${stats.percent}%">
            <svg viewBox="0 0 100 100">
                <circle class="track" cx="50" cy="50" r="${RING_RADIUS}" fill="none" stroke-width="9"/>
                <circle class="bar" cx="50" cy="50" r="${RING_RADIUS}" fill="none" stroke-width="9" stroke-linecap="round"
                    stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${offset}"/>
            </svg>
            <span>${stats.percent}%</span>
        </div>
        <span class="divider"></span>
        <div class="stat">
            <span class="big">${stats.done}<small>/${stats.total}</small></span>
            <span class="label">실행한 계획</span>
        </div>
        <span class="divider"></span>
        <div class="stat">
            <span class="big">${stats.sets}</span>
            <span class="label">SET</span>
        </div>
        <span class="divider d2"></span>
        <div class="cat-hours">${cats}</div>`;
}

function loadCalendar() {
    try {
        return JSON.parse(localStorage.getItem(CALENDAR_KEY)) || null;
    } catch {
        return null;
    }
}

let calendar = loadCalendar();

// 원격에서 받은 캘린더가 바뀌었으면 저장하고 true
function updateCalendar(next) {
    if (!next || next.fetchedAt === calendar?.fetchedAt) return false;
    calendar = next;
    try {
        localStorage.setItem(CALENDAR_KEY, JSON.stringify(next));
    } catch {
        // 저장 못 해도 이번 화면에는 보인다
    }
    return true;
}

function calChipsHtml(events) {
    if (!events.length) return '';
    const chips = events.slice(0, CAL_CHIPS_MAX).map((e) => {
        const time = e.continued ? '↳' : clockLabel(e.startMs);
        return `<span class="cal-chip${e.continued ? ' cont' : ''}" title="${esc(e.title)}"><b>${time}</b> ${esc(e.title)}</span>`;
    }).join('');
    const more = events.length > CAL_CHIPS_MAX ? `<span class="cal-chip more">+${events.length - CAL_CHIPS_MAX}</span>` : '';
    return `<span class="cal-chips">${chips}${more}</span>`;
}

function renderAllDay(allDay) {
    const el = $('#calAllDay');
    el.hidden = !allDay.length;
    el.innerHTML = allDay.length
        ? `<span class="cal-allday-label">📅 종일</span>${allDay.map((e) => `<span class="cal-chip">${esc(e.title)}</span>`).join('')}`
        : '';
}

function isNowSlot(hour) {
    const start = slotStart(currentKey, hour, state.settings.startHour).getTime();
    const now = Date.now();
    return now >= start && now < start + HOUR_MS;
}

function catCell(item) {
    if (!item.cat) return `<button class="cell-btn" data-edit="${item.hour}" aria-label="${hourLabel(item.hour)} 분류 입력"></button>`;
    const inner = item.catSpan > 1
        ? `<span class="cat-block" data-cat="${item.cat}">${item.cat}</span>`
        : `<span class="cat-single" data-cat="${item.cat}"><span class="dot"></span>${item.cat}</span>`;
    return `<button class="cell-btn" style="padding:0" data-edit="${item.hour}">${inner}</button>`;
}

// PLAN 칸: 사용자 계획 + 그 시간과 겹치는 캘린더 일정(작게)
function planCell(item, span, chips) {
    // PLAN에 넣기로 옮긴 일정은 같은 제목이 두 번 보이지 않게
    const extra = chips.filter((e) => e.title.trim() !== item.plan.trim());
    const text = `<span class="plan-text">${esc(item.plan)}</span>${calChipsHtml(extra)}`;
    if (span > 1) {
        return `<button class="cell-btn" style="padding:0" data-edit="${item.hour}"><span class="plan-block plan">${text}</span></button>`;
    }
    return `<button class="cell-btn plan" data-edit="${item.hour}">${text}</button>`;
}

// 비어 있는 PLAN 칸을 채운 캘린더 일정 블록 (저장되지 않는 표시)
function calBlockCell(item, cell) {
    const e = cell.event;
    const time = `${e.continued ? '↳ ' : ''}${clockLabel(e.startMs)}–${clockLabel(e.endMs)}`;
    return `<button class="cell-btn" style="padding:0" data-edit="${item.hour}" aria-label="캘린더 일정 ${esc(e.title)} ${time}">
        <span class="plan-block cal-block"><span class="cal-block-time">📅 ${time}</span>
        <span class="cal-block-title">${esc(e.title)}</span>${calChipsHtml(cell.chips)}</span></button>`;
}

function renderTable(layout) {
    const cal = calendarForDay(calendar?.events, currentKey, state.settings.startHour);
    renderAllDay(cal.allDay);
    const planCells = planColumn(layout, cal.byHour);
    const html = layout.map((item, i) => {
        const cls = [item.setNo ? 'in-set' : '', isNowSlot(item.hour) ? 'now' : ''].join(' ').trim();
        const cells = [];
        if (item.setSpan > 0) {
            cells.push(`<td class="c-set-cell line" rowspan="${item.setSpan}"><span class="set-badge">${item.setNo}</span></td>`);
        } else if (!item.setNo) {
            cells.push('<td class="c-set-cell line"></td>');
        }
        cells.push(`<td class="time-cell line"><button class="cell-btn time" data-edit="${item.hour}">${hourLabel(item.hour)}</button></td>`);
        if (item.catSpan > 0) cells.push(`<td class="line" rowspan="${item.catSpan}">${catCell(item)}</td>`);
        if (item.actionSpan > 0) {
            const doneCls = item.actionDone && item.action ? ' done' : '';
            cells.push(`<td class="line" rowspan="${item.actionSpan}"><button class="cell-btn action${doneCls}" data-edit="${item.hour}">${esc(item.action)}</button></td>`);
        }
        const pri = item.row.pri ? `<span class="pri p${item.row.pri}">${item.row.pri}</span>` : '';
        cells.push(`<td class="line"><button class="pri-btn" data-pri="${item.hour}" aria-label="우선순위 ${item.row.pri || '없음'}">${pri}</button></td>`);
        cells.push(`<td class="line"><button class="check-btn" data-check="${item.hour}" role="checkbox" aria-checked="${item.row.done}" aria-label="${hourLabel(item.hour)} 완료"><span class="check${item.row.done ? ' on' : ''}">${ICONS.check}</span></button></td>`);
        const planCellInfo = planCells[i];
        if (planCellInfo.kind === 'cal') {
            cells.push(`<td class="line" rowspan="${planCellInfo.span}">${calBlockCell(item, planCellInfo)}</td>`);
        } else if (planCellInfo.kind === 'user') {
            cells.push(`<td class="line" rowspan="${planCellInfo.span}">${planCell(item, planCellInfo.span, planCellInfo.chips)}</td>`);
        }
        return `<tr class="${cls}" data-hour="${item.hour}">${cells.join('')}</tr>`;
    }).join('');
    $('#ttBody').innerHTML = html;
}

function fitnessHead(d, subtitle) {
    return `
        <div class="panel-head">
            <span class="panel-icon">${ICONS.dumbbell}</span>
            <div class="panel-titles">
                <h2 class="panel-title">FITNESS</h2>
                ${subtitle ? `<span class="panel-sub">${subtitle}</span>` : ''}
            </div>
            <div class="panel-aside">
                <span>수면 <input class="mini-input" data-meta="sleep" inputmode="decimal" value="${esc(d.meta.sleep)}" aria-label="수면 시간">시간</span>
                <span>· 체중 <input class="mini-input" data-meta="weight" inputmode="decimal" value="${esc(d.meta.weight)}" aria-label="체중">kg</span>
                <button type="button" class="edit-toggle" data-toggle="fitness">${editFitness ? '완료' : '편집'}</button>
            </div>
        </div>`;
}

// 합계 칸: 실제 합계 위, 목표 아래
function fitnessTotalHtml(values, target) {
    const actual = fitnessTotal(values);
    if (!target) return formatNum(actual);
    if (target.note) return `${formatNum(actual)}<small>${esc(target.note)}</small>`;
    if (!target.sets) return actual ? formatNum(actual) : '<small>휴식</small>';
    return `${formatNum(actual)}<small>/${target.total}</small>`;
}

function fitnessTotalClass(values, target) {
    return target?.sets && fitnessTotal(values) >= target.total ? 'total met' : 'total';
}

function fitnessEditHtml() {
    const program = state.program;
    const programBox = `
        <div class="program-box">
            <div class="label-row"><span class="label">8주 프로그램</span>
                <button type="button" class="edit-toggle" data-program-toggle>${program ? '끄기' : '켜기'}</button></div>
            ${program ? `
            <label class="program-start">시작일 (1주차 월요일)
                <input type="date" data-program-start value="${esc(program.startDate)}"></label>
            <p class="hint">기간 안의 날에는 요일에 맞는 목표가 회색으로 보이고, 실제로 한 횟수를 입력하면 돼요.</p>` : '<p class="hint">켜면 날짜별 세트 목표가 표시돼요.</p>'}
        </div>`;
    const rows = state.exercises.map((ex, i) => `
        <div class="edit-row">
            <input data-ex-name="${i}" value="${esc(ex.name)}" placeholder="운동 이름" aria-label="운동 이름">
            <select data-ex-unit="${i}" aria-label="단위">${UNITS.map((u) => `<option${u === ex.unit ? ' selected' : ''}>${u}</option>`).join('')}</select>
            <button type="button" class="del-btn" data-ex-del="${i}" aria-label="${esc(ex.name)} 삭제">✕</button>
        </div>`).join('');
    return `${programBox}
        <p class="section-title" style="margin-top:14px">프로그램 밖의 날 운동 목록</p>
        <div class="edit-list">${rows}<button type="button" class="add-btn" data-ex-add>+ 운동 추가</button></div>`;
}

function fitnessTable(rows, d) {
    const nums = Array.from({ length: FITNESS_SETS }, (_, i) => `<th>${i + 1}</th>`).join('');
    const body = rows.map(({ key, name, unit, target }) => {
        const values = d.fitness[key] ?? [];
        const inputs = Array.from({ length: FITNESS_SETS }, (_, i) => {
            const planned = target && i < target.sets;
            return `<td${planned ? ' class="planned"' : ''}><input class="rep" data-ex="${key}" data-i="${i}" inputmode="decimal"
                value="${esc(values[i])}"${planned ? ` placeholder="${target.rep}"` : ''}
                aria-label="${esc(name)} ${i + 1}세트${planned ? ` 목표 ${target.rep}` : ''}"></td>`;
        }).join('');
        const rest = target && !target.sets && !target.note ? ' class="rest"' : '';
        return `<tr${rest}>
            <td class="ex-name">${esc(name)}<small>${esc(unit)}</small></td>${inputs}
            <td class="${fitnessTotalClass(values, target)}" data-total="${key}">${fitnessTotalHtml(values, target)}</td>
        </tr>`;
    }).join('');
    return `<div class="fit-wrap"><table class="fit">
        <colgroup><col class="c-name">${'<col>'.repeat(FITNESS_SETS)}<col class="c-total"></colgroup>
        <thead><tr><th></th>${nums}<th class="total">합계</th></tr></thead>
        <tbody>${body || `<tr><td colspan="${FITNESS_SETS + 2}" class="hint">편집을 눌러 운동을 추가하세요</td></tr>`}</tbody>
    </table></div>`;
}

// 보고 있는 날의 운동 행 — 프로그램 기간이면 프로그램 목표, 아니면 사용자 목록
function fitnessRows() {
    const plan = programDay(state.program?.startDate, currentKey);
    if (plan) return { plan, rows: plan.rows.map((r) => ({ key: r.key, name: r.name, unit: r.unit, target: r })) };
    return { plan: null, rows: state.exercises.map((ex) => ({ key: ex.id, name: ex.name, unit: ex.unit, target: null })) };
}

function renderFitness() {
    const d = day();
    const { plan, rows } = fitnessRows();
    const subtitle = plan ? `${plan.week + 1}주차 · ${esc(plan.stage)} · ${plan.dayLabel}` : '';
    if (editFitness) {
        $('#fitness').innerHTML = fitnessHead(d, subtitle) + fitnessEditHtml();
        return;
    }
    const tip = plan ? `<p class="fit-tip">${esc(plan.tip)}</p>` : '';
    $('#fitness').innerHTML = fitnessHead(d, subtitle) + fitnessTable(rows, d) + tip;
}

function formatNum(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function renderHabits() {
    const d = day();
    const done = state.habits.filter((h) => d.habitsDone[h.id]).length;
    const head = `
        <div class="panel-head">
            <span class="panel-icon ok">${ICONS.check}</span>
            <h2 class="panel-title">HABITS</h2>
            <div class="panel-aside">
                <span class="count">${done}/${state.habits.length}</span>
                <button type="button" class="edit-toggle" data-toggle="habits">${editHabits ? '완료' : '편집'}</button>
            </div>
        </div>`;
    if (editHabits) {
        const rows = state.habits.map((h, i) => `
            <div class="edit-row">
                <input data-habit-name="${i}" value="${esc(h.name)}" placeholder="습관" aria-label="습관 이름">
                <button type="button" class="del-btn" data-habit-del="${i}" aria-label="${esc(h.name)} 삭제">✕</button>
            </div>`).join('');
        $('#habits').innerHTML = `${head}<div class="edit-list">${rows}<button type="button" class="add-btn" data-habit-add>+ 습관 추가</button></div>`;
        return;
    }
    const items = state.habits.map((h) => `
        <button type="button" class="habit" data-habit="${h.id}" role="checkbox" aria-checked="${Boolean(d.habitsDone[h.id])}">
            <span class="check${d.habitsDone[h.id] ? ' on' : ''}">${ICONS.check}</span>${esc(h.name)}
        </button>`).join('');
    $('#habits').innerHTML = `${head}<div class="habit-grid">${items || '<p class="hint">편집을 눌러 습관을 추가하세요</p>'}</div>`;
}

const NOTE_SECTIONS = [['keyword', 'KEYWORD'], ['idea', 'IDEA'], ['etc', 'ETC.']];

function renderNote() {
    const d = day();
    const secs = NOTE_SECTIONS.map(([key, label]) => `
        <div class="note-sec">
            <span class="note-tag">${label}</span>
            <textarea class="note-text" data-note="${key}" rows="1" placeholder="입력" aria-label="${label}">${esc(d.note[key])}</textarea>
        </div>`).join('');
    $('#note').innerHTML = `
        <div class="panel-head">
            <span class="panel-icon">${ICONS.pencil}</span>
            <h2 class="panel-title">NOTE</h2>
        </div>${secs}`;
    document.querySelectorAll('.note-text').forEach(autosize);
}

function autosize(el) {
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
}

// ---------- 시간표 이벤트 ----------

$('#ttBody').addEventListener('click', (e) => {
    const check = e.target.closest('[data-check]');
    if (check) {
        const row = day().rows[Number(check.dataset.check)];
        row.done = !row.done;
        save();
        renderBoard();
        return;
    }
    const pri = e.target.closest('[data-pri]');
    if (pri) {
        const row = day().rows[Number(pri.dataset.pri)];
        row.pri = (row.pri + 1) % (PRIORITY_MAX + 1);
        save();
        renderBoard();
        return;
    }
    const edit = e.target.closest('[data-edit]');
    if (edit) openRow(Number(edit.dataset.edit));
});

// ---------- 시간 칸 편집 시트 ----------

let sheetHour = null;

function openRow(hour) {
    sheetHour = hour;
    buildRowForm();
    const dlg = $('#rowSheet');
    if (!dlg.open) dlg.showModal();
}

function mergeBox(name, checked, disabled) {
    return `<label class="merge"><input type="checkbox" name="${name}"${checked ? ' checked' : ''}${disabled ? ' disabled' : ''}>위 칸과 합치기</label>`;
}

function buildRowForm() {
    const hour = sheetHour;
    const row = day().rows[hour];
    const layout = layoutOf();
    const item = layout.find((it) => it.hour === hour);
    const isFirst = item.index === 0;
    const catHead = day().rows[item.catHead];
    const catChips = ['', ...CATEGORY_IDS].map((id) => `
        <label${id ? ` data-cat="${id}"` : ''}><input type="radio" name="cat" value="${id}"${item.cat === id ? ' checked' : ''}${row.catMerge ? ' disabled' : ''}>
        <span>${id ? `<span class="dot"></span>${id}` : '없음'}</span></label>`).join('');
    const priChips = Array.from({ length: PRIORITY_MAX + 1 }, (_, p) => `
        <label><input type="radio" name="pri" value="${p}"${row.pri === p ? ' checked' : ''}><span>${p || '없음'}</span></label>`).join('');

    $('#rowForm').innerHTML = `
        <div class="sheet-head">
            <button type="button" class="nav-btn" data-move="-1" aria-label="이전 시간">‹</button>
            <h2>${hourLabel(hour)}</h2>
            <button type="button" class="nav-btn" data-move="1" aria-label="다음 시간">›</button>
            <span class="grow"></span>
            <button type="submit" class="btn small primary" value="close">닫기</button>
        </div>
        <div class="field">
            <div class="label-row"><span class="label">분류</span>${mergeBox('catMerge', row.catMerge && !isFirst, isFirst)}</div>
            <div class="chips">${catChips}</div>
            <label class="merge"><input type="checkbox" name="set"${catHead.set ? ' checked' : ''}${item.cat ? '' : ' disabled'}>이 분류 블록을 SET으로 지정 (${item.catSpan || layout.find((it) => it.hour === item.catHead).catSpan}시간)</label>
        </div>
        <div class="field">
            <div class="label-row"><span class="label">ACTION · 실제로 한 일</span>${mergeBox('actMerge', row.actMerge && !isFirst, isFirst)}</div>
            <textarea name="action" rows="2" placeholder="무엇을 했나요?"${row.actMerge && !isFirst ? ' disabled' : ''}>${esc(item.action)}</textarea>
        </div>
        <div class="field">
            <div class="label-row"><span class="label">PLAN · 계획</span>${mergeBox('planMerge', row.planMerge && !isFirst, isFirst)}</div>
            <input type="text" name="plan" placeholder="무엇을 할 계획인가요?" value="${esc(item.plan)}"${row.planMerge && !isFirst ? ' disabled' : ''}>
        </div>
        <div class="field">
            <span class="label">우선순위</span>
            <div class="chips">${priChips}</div>
        </div>
        ${slotEventsHtml(hour)}
        <div class="sheet-actions">
            <button type="button" class="btn${row.done ? ' ok' : ''}" data-act="done">${row.done ? '✓ 완료함' : '완료 체크'}</button>
            <button type="button" class="btn danger" data-act="clear">이 칸 비우기</button>
        </div>`;
}

// 일정이 차지하던 빈 칸 블록이 있으면 그 칸들을 합쳐 PLAN 으로 저장, 아니면 이 칸(블록)의 PLAN 만
function insertEventAsPlan(event) {
    const rows = day().rows;
    const layout = layoutOf();
    const cells = planColumn(layout, calendarForDay(calendar?.events, currentKey, state.settings.startHour).byHour);
    const index = layout.findIndex((it) => it.hour === sheetHour);
    let head = index;
    while (head > 0 && cells[head].kind === 'skip') head -= 1;
    const cell = cells[head];
    if (cell.kind === 'cal' && calendarEventKey(cell.event) === calendarEventKey(event)) {
        layout.slice(head, head + cell.span).forEach((it, k) => {
            rows[it.hour].plan = k === 0 ? event.title : '';
            rows[it.hour].planMerge = k > 0;
        });
        return;
    }
    rows[layout[index].planHead].plan = event.title;
}

function slotEventsHtml(hour) {
    const events = eventsInSlot(calendar?.events, currentKey, hour, state.settings.startHour);
    if (!events.length) return '';
    const items = events.map((e, i) => `
        <li><span><b>${clockLabel(Date.parse(e.start))}–${clockLabel(Date.parse(e.end))}</b> ${esc(e.title)}
            ${e.location ? `<small>${esc(e.location)}</small>` : ''}</span>
            <button type="button" class="btn small" data-cal-plan="${i}">PLAN에 넣기</button></li>`).join('');
    return `<div class="field"><span class="label">📅 아이폰 캘린더</span><ul class="slot-events">${items}</ul></div>`;
}

function applyRowForm() {
    const form = $('#rowForm');
    const f = form.elements;
    const rows = day().rows;
    const row = rows[sheetHour];
    row.catMerge = f.catMerge.checked;
    row.actMerge = f.actMerge.checked;
    row.planMerge = f.planMerge.checked;
    if (!row.catMerge && !f.cat[0].disabled) row.cat = f.cat.value;
    if (!f.action.disabled) row.action = f.action.value;
    if (!f.plan.disabled) row.plan = f.plan.value;
    row.pri = Number(f.pri.value) || 0;
    const item = buildLayout(rows, state.settings.startHour).find((it) => it.hour === sheetHour);
    if (!f.set.disabled) rows[item.catHead].set = f.set.checked;
    save();
    renderBoard();
}

$('#rowForm').addEventListener('input', (e) => {
    if (e.target.matches('textarea, input[type=text]')) applyRowForm();
});

$('#rowForm').addEventListener('change', (e) => {
    if (e.target.matches('textarea, input[type=text]')) return;
    // 합치기를 켜고 끄면 현재 칸에 보이는 값이 바뀌므로, 그 전에 입력 칸 상태를 반영한다
    applyRowForm();
    buildRowForm();
});

$('#rowForm').addEventListener('click', (e) => {
    const move = e.target.closest('[data-move]');
    if (move) {
        const hours = displayHours(state.settings.startHour);
        const idx = hours.indexOf(sheetHour) + Number(move.dataset.move);
        if (idx >= 0 && idx < hours.length) openRow(hours[idx]);
        return;
    }
    const calBtn = e.target.closest('[data-cal-plan]');
    if (calBtn) {
        const event = eventsInSlot(calendar?.events, currentKey, sheetHour, state.settings.startHour)[Number(calBtn.dataset.calPlan)];
        if (event) insertEventAsPlan(event);
        save();
        renderBoard();
        buildRowForm();
        return;
    }
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const rows = day().rows;
    if (act.dataset.act === 'done') rows[sheetHour].done = !rows[sheetHour].done;
    if (act.dataset.act === 'clear') rows[sheetHour] = emptyRow();
    save();
    renderBoard();
    buildRowForm();
});

for (const dlg of document.querySelectorAll('dialog')) {
    // 바깥(배경)을 누르면 닫는다
    dlg.addEventListener('click', (e) => {
        if (e.target === dlg) dlg.close();
    });
}

// ---------- 오른쪽 패널 이벤트 ----------

$('#fitness').addEventListener('input', (e) => {
    const t = e.target;
    const d = day();
    if (t.dataset.ex) {
        const values = d.fitness[t.dataset.ex] ?? Array(FITNESS_SETS).fill('');
        values[Number(t.dataset.i)] = t.value;
        d.fitness[t.dataset.ex] = values;
        const { target } = fitnessRows().rows.find((r) => r.key === t.dataset.ex) ?? {};
        const cell = $(`[data-total="${t.dataset.ex}"]`);
        cell.innerHTML = fitnessTotalHtml(values, target);
        cell.className = fitnessTotalClass(values, target);
    } else if (t.dataset.meta) {
        d.meta[t.dataset.meta] = t.value;
    } else if (t.dataset.exName) {
        state.exercises[Number(t.dataset.exName)].name = t.value;
    } else if (t.dataset.exUnit) {
        state.exercises[Number(t.dataset.exUnit)].unit = t.value;
    }
    save(t.dataset.ex || t.dataset.meta ? 'day' : 'meta');
});

$('#fitness').addEventListener('change', (e) => {
    if (!e.target.matches('[data-program-start]') || !e.target.value) return;
    state.program = { startDate: e.target.value };
    save('meta');
    renderFitness();
});

$('#fitness').addEventListener('click', (e) => {
    if (e.target.closest('[data-toggle]')) {
        editFitness = !editFitness;
    } else if (e.target.closest('[data-ex-add]')) {
        state.exercises.push({ id: uid(), name: '', unit: UNITS[0] });
        save('meta');
    } else if (e.target.closest('[data-ex-del]')) {
        state.exercises.splice(Number(e.target.closest('[data-ex-del]').dataset.exDel), 1);
        save('meta');
    } else if (e.target.closest('[data-program-toggle]')) {
        state.program = state.program ? null : { startDate: mondayOf(currentKey) };
        save('meta');
    } else {
        return;
    }
    renderFitness();
    if (e.target.closest('[data-ex-add]')) $('#fitness .edit-row:last-of-type input')?.focus();
});

$('#habits').addEventListener('input', (e) => {
    if (!e.target.dataset.habitName) return;
    state.habits[Number(e.target.dataset.habitName)].name = e.target.value;
    save('meta');
});

$('#habits').addEventListener('click', (e) => {
    const habit = e.target.closest('[data-habit]');
    if (habit) {
        const done = day().habitsDone;
        done[habit.dataset.habit] = !done[habit.dataset.habit];
        save();
    } else if (e.target.closest('[data-toggle]')) {
        editHabits = !editHabits;
    } else if (e.target.closest('[data-habit-add]')) {
        state.habits.push({ id: uid(), name: '' });
        save('meta');
    } else if (e.target.closest('[data-habit-del]')) {
        state.habits.splice(Number(e.target.closest('[data-habit-del]').dataset.habitDel), 1);
        save('meta');
    } else {
        return;
    }
    renderHabits();
    if (editHabits && e.target.closest('[data-habit-add]')) $('#habits .edit-row:last-of-type input')?.focus();
});

$('#note').addEventListener('input', (e) => {
    if (!e.target.dataset.note) return;
    day().note[e.target.dataset.note] = e.target.value;
    autosize(e.target);
    save();
});

// ---------- 날짜 이동 ----------

function goTo(key) {
    currentKey = key;
    editHabits = false;
    editFitness = false;
    render();
}

$('#prevDay').addEventListener('click', () => goTo(addDays(currentKey, -1)));
$('#nextDay').addEventListener('click', () => goTo(addDays(currentKey, 1)));
$('#todayBtn').addEventListener('click', () => goTo(toKey(new Date())));
$('#dateBtn').addEventListener('click', () => {
    const picker = $('#datePicker');
    try {
        picker.showPicker();
    } catch {
        picker.focus();
        picker.click();
    }
});
$('#datePicker').addEventListener('change', (e) => {
    if (e.target.value) goTo(e.target.value);
});

// ---------- 알림 ----------

function notifySupported() {
    return 'Notification' in window;
}

function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIos() {
    return /iP(hone|ad|od)/.test(navigator.userAgent)
        || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function showNotification(title, body, tag) {
    const options = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', renotify: true };
    try {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) {
            await reg.showNotification(title, options);
            return;
        }
    } catch {
        // 서비스 워커가 없으면 페이지 알림으로 대체
    }
    try {
        new Notification(title, options);
    } catch {
        toast(`🔔 ${title}`);
    }
}

function eventsAround(todayKey) {
    const { startHour } = state.settings;
    return [-1, 0, 1].flatMap((n) => {
        const key = addDays(todayKey, n);
        const d = state.days[key] ?? (state.template ? emptyDay(state.template) : null);
        return d ? planEvents(key, buildLayout(d.rows, startHour), startHour) : [];
    });
}

let lastRenderedHour = new Date().getHours();

function tick() {
    const now = Date.now();
    let last = now;
    try {
        last = Number(localStorage.getItem(TICK_KEY)) || now;
        localStorage.setItem(TICK_KEY, String(now));
    } catch {
        // 저장소를 못 쓰면 이번 틱만 확인
    }
    const from = Math.max(last, now - MAX_CATCHUP_MS);

    // 정각이 지나면 "지금" 표시를 옮긴다
    const hour = new Date().getHours();
    if (hour !== lastRenderedHour) {
        lastRenderedHour = hour;
        renderBoard();
    }

    const { enabled, lead } = state.settings.notify;
    if (!enabled || !notifySupported() || Notification.permission !== 'granted') return;
    dueAlerts(eventsAround(toKey(new Date())), lead, from, now).forEach((event) => {
        const title = lead ? `${lead}분 후 · ${eventTitle(event)}` : eventTitle(event);
        showNotification(title, eventBody(event), `${event.dayKey}-${event.hour}`);
        if (document.visibilityState === 'visible') toast(`🔔 ${title}`);
    });
}

async function enableNotifications() {
    if (!notifySupported()) {
        toast(isIos() && !isStandalone()
            ? 'iPhone은 홈 화면에 추가한 앱에서만 알림을 켤 수 있어요'
            : '이 브라우저는 알림을 지원하지 않아요');
        return;
    }
    const permission = await Notification.requestPermission();
    state.settings.notify.enabled = permission === 'granted';
    save('none');
    if (permission === 'granted') {
        showNotification('알림이 켜졌어요', '계획한 시간이 되면 알려드릴게요', 'enabled');
    } else {
        toast('알림이 차단되어 있어요. 기기 설정에서 허용해 주세요');
    }
    buildSettingsForm();
}

// ---------- 캘린더(.ics) / 백업 ----------

function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function exportIcs(dayCount) {
    const { startHour, notify } = state.settings;
    const events = Array.from({ length: dayCount }, (_, i) => addDays(currentKey, i)).flatMap((key) => {
        const d = state.days[key] ?? (state.template ? emptyDay(state.template) : null);
        return d ? planEvents(key, buildLayout(d.rows, startHour), startHour) : [];
    });
    if (!events.length) {
        toast('내보낼 계획이 없어요. ACTION이나 PLAN을 먼저 적어 주세요');
        return;
    }
    download(`planner-${currentKey}${dayCount > 1 ? `-${dayCount}d` : ''}.ics`, buildIcs(events, notify.lead), 'text/calendar');
    toast(`${events.length}개 일정을 캘린더 파일로 내보냈어요`);
}

function exportBackup() {
    download(`planner-backup-${toKey(new Date())}.json`, JSON.stringify(state, null, 2), 'application/json');
}

async function importBackup(file) {
    try {
        const data = JSON.parse(await file.text());
        if (!data || typeof data.days !== 'object' || !Array.isArray(data.habits)) throw new Error('형식 오류');
        if (!window.confirm('현재 데이터를 백업 파일 내용으로 바꿀까요?')) return;
        localStorage.setItem(STORE_KEY, JSON.stringify(data));
        state = loadState();
        $('#settingsSheet').close();
        render();
        toast('백업을 불러왔어요');
    } catch {
        toast('백업 파일을 읽을 수 없어요');
    }
}

// ---------- 기기 간 동기화 (GitHub Gist) ----------

let pushTimer = null;
let syncing = null;
let syncAgain = false;
let syncError = '';

function readSyncConfig() {
    try {
        return JSON.parse(localStorage.getItem(SYNC_KEY)) || null;
    } catch {
        return null;
    }
}

function writeSyncConfig(config) {
    try {
        if (config) localStorage.setItem(SYNC_KEY, JSON.stringify(config));
        else localStorage.removeItem(SYNC_KEY);
    } catch {
        toast('동기화 설정을 저장하지 못했어요');
    }
}

function schedulePush() {
    if (!readSyncConfig()) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => syncNow(), SYNC_PUSH_DELAY_MS);
}

function persistNow() {
    clearTimeout(saveTimer);
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch {
        toast('저장 공간이 부족해 저장하지 못했어요');
    }
}

function isTyping() {
    return document.activeElement?.matches('input, textarea, select');
}

// 원격에 로컬보다 새로운 것이 있었는가
function remoteBroughtChanges(before, merged) {
    return (merged.metaUpdatedAt ?? 0) > (before.metaUpdatedAt ?? 0)
        || Object.keys(merged.days).some((key) => merged.days[key] !== before.days[key]);
}

// 로컬에 원격보다 새로운 것이 있는가
function needsPush(payload, remote) {
    if (!remote) return true;
    if (payload.metaUpdatedAt > (remote.metaUpdatedAt ?? 0)) return true;
    return Object.entries(payload.days).some(([key, d]) => d.updatedAt !== remote.days?.[key]?.updatedAt);
}

function syncStatusText() {
    const config = readSyncConfig();
    if (!config) return '꺼짐';
    if (syncing) return '동기화 중…';
    if (syncError) return '오류';
    if (!config.lastSync) return '연결됨';
    const t = new Date(config.lastSync);
    return `${t.getHours()}:${String(t.getMinutes()).padStart(2, '0')} 동기화됨`;
}

function updateSyncStatus() {
    const pill = document.getElementById('syncStatus');
    if (!pill) return;
    pill.textContent = syncStatusText();
    pill.classList.toggle('on', Boolean(readSyncConfig()) && !syncError);
    const err = document.getElementById('syncError');
    if (err) err.textContent = syncError;
}

async function syncNow({ manual = false } = {}) {
    const config = readSyncConfig();
    if (!config) return;
    if (syncing) {
        syncAgain = true;
        return;
    }
    clearTimeout(pushTimer);
    syncing = (async () => {
        try {
            const { data: remote, calendar: remoteCalendar } = await readGist(config.token, config.gistId);
            const before = state;
            const merged = mergeStates(state, remote);
            state = merged;
            persistNow();
            const calendarChanged = updateCalendar(remoteCalendar);
            if (remoteBroughtChanges(before, merged) || calendarChanged) {
                if (isTyping()) {
                    renderHeader();
                    renderBoard();
                } else {
                    render();
                }
            }
            const payload = toSyncPayload(merged);
            if (needsPush(payload, remote)) await writeGist(config.token, config.gistId, payload);
            writeSyncConfig({ ...config, lastSync: Date.now() });
            syncError = '';
            if (manual) toast('동기화했어요');
            updateCalendarStatus();
        } catch (err) {
            const first = !syncError;
            syncError = err.message;
            if (manual || (first && err.status)) toast(err.message);
        }
    })();
    updateSyncStatus();
    await syncing;
    syncing = null;
    updateSyncStatus();
    if (syncAgain) {
        syncAgain = false;
        syncNow();
    }
}

async function connectSync() {
    const token = $('#settingsForm [name=syncToken]')?.value.trim();
    if (!token) {
        toast('토큰을 붙여넣어 주세요');
        return;
    }
    const btn = $('#settingsForm [data-set=sync-connect]');
    btn.disabled = true;
    btn.textContent = '연결 중…';
    try {
        const gistId = await findGist(token);
        if (gistId) {
            writeSyncConfig({ token, gistId });
            await syncNow();
            toast('다른 기기의 기록과 합쳤어요');
        } else {
            const created = await createGist(token, toSyncPayload(state));
            writeSyncConfig({ token, gistId: created, lastSync: Date.now() });
            toast('동기화를 시작했어요. 다른 기기에서도 같은 토큰으로 연결하세요');
        }
        syncError = '';
    } catch (err) {
        toast(err.message);
    }
    buildSettingsForm();
}

async function copySyncToken() {
    const config = readSyncConfig();
    try {
        await navigator.clipboard.writeText(config.token);
        toast('토큰을 복사했어요. 다른 기기의 동기화 칸에 붙여넣으세요');
    } catch {
        toast('복사하지 못했어요');
    }
}

function syncSectionHtml() {
    const config = readSyncConfig();
    const head = `<p class="section-title">🔄 기기 간 동기화 <span class="status-pill" id="syncStatus"></span></p>`;
    if (!config) {
        return `${head}
        <p class="hint">GitHub 비공개 Gist에 저장해서 폰과 맥이 같은 기록을 보게 해요.
        <b>기록이 많은 기기에서 먼저</b> 연결하세요.<br>
        1. <a href="https://github.com/settings/tokens/new?scopes=gist&amp;description=4X%20Planner%20sync" target="_blank" rel="noopener">GitHub 토큰 만들기</a> — <b>gist</b> 권한만 체크 → Generate token<br>
        2. 만든 토큰을 아래에 붙여넣고 <b>연결</b><br>
        3. 다른 기기에서도 같은 토큰으로 연결</p>
        <div class="field"><input type="password" name="syncToken" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="ghp_… 토큰 붙여넣기" aria-label="GitHub 토큰"></div>
        <button type="button" class="btn ok" data-set="sync-connect">연결</button>`;
    }
    return `${head}
        <p class="hint">앱을 열 때, 수정할 때, 그리고 1분마다 자동으로 동기화해요. 같은 날을 두 기기에서 동시에 고치면 <b>나중에 고친 쪽</b>이 남아요.
        <span id="syncError" style="color:#d0453a"></span></p>
        <div class="btn-row">
            <button type="button" class="btn" data-set="sync-now">지금 동기화</button>
            <button type="button" class="btn" data-set="sync-copy">토큰 복사</button>
            <button type="button" class="btn danger" data-set="sync-disconnect">연결 끊기</button>
        </div>`;
}

// ---------- 아이폰 캘린더 설정 ----------

function calendarStatusText() {
    if (!readSyncConfig()) return '동기화 먼저';
    if (!state.settings.calendarUrls?.length) return '꺼짐';
    if (!calendar) return '첫 수집 대기 중';
    if (calendar.errors?.length) return '오류';
    const t = new Date(calendar.fetchedAt);
    return `일정 ${calendar.events.length}개 · ${t.getMonth() + 1}/${t.getDate()} ${clockLabel(t.getTime())}`;
}

function updateCalendarStatus() {
    const pill = document.getElementById('calStatus');
    if (!pill) return;
    pill.textContent = calendarStatusText();
    pill.classList.toggle('on', Boolean(calendar && !calendar.errors?.length && state.settings.calendarUrls?.length));
    const err = document.getElementById('calErrors');
    if (err) err.textContent = calendar?.errors?.join(' / ') ?? '';
}

function calendarSectionHtml() {
    const urls = (state.settings.calendarUrls ?? []).join('\n');
    return `
        <p class="section-title">📅 아이폰 캘린더 가져오기 <span class="status-pill" id="calStatus"></span></p>
        <p class="hint">캘린더 일정을 시간표 PLAN 칸에 작게 보여줘요(30분마다 갱신, PLAN 내용은 바꾸지 않아요).
        ${readSyncConfig() ? '' : '<br><b>위의 기기 간 동기화를 먼저 연결해야 해요.</b>'}<br>
        1. 아이폰 <b>캘린더</b> 앱 → 아래 <b>캘린더</b> → 가져올 캘린더의 ⓘ → <b>공개 캘린더</b> 켜기 → <b>링크 공유 → 복사</b><br>
        2. 아래 칸에 붙여넣기 (여러 개면 한 줄에 하나)<br>
        ⚠️ 공개 캘린더는 링크를 아는 사람이면 볼 수 있어요. 링크를 다른 곳에 올리지 마세요.
        <span id="calErrors" style="color:#d0453a;display:block"></span></p>
        <div class="field"><textarea name="calendarUrls" rows="2" autocomplete="off" autocapitalize="off" spellcheck="false"
            placeholder="webcal://p00-caldav.icloud.com/published/2/..." aria-label="캘린더 공유 링크">${esc(urls)}</textarea></div>`;
}

// ---------- 설정 시트 ----------

function notifyStatus() {
    if (!notifySupported()) return isIos() && !isStandalone() ? '홈 화면 앱에서 사용 가능' : '지원 안 됨';
    if (Notification.permission === 'denied') return '차단됨';
    if (Notification.permission === 'granted' && state.settings.notify.enabled) return '켜짐';
    return '꺼짐';
}

function buildSettingsForm() {
    const s = state.settings;
    const status = notifyStatus();
    const hourOptions = Array.from({ length: 24 }, (_, h) => `<option value="${h}"${h === s.startHour ? ' selected' : ''}>${hourLabel(h)}</option>`).join('');
    const leadOptions = LEAD_OPTIONS.map((m) => `<option value="${m}"${m === s.notify.lead ? ' selected' : ''}>${m ? `${m}분 전` : '정각'}</option>`).join('');
    const granted = notifySupported() && Notification.permission === 'granted';
    $('#settingsForm').innerHTML = `
        <div class="sheet-head"><h2>설정</h2><span class="grow"></span><button type="submit" class="btn small primary" value="close">닫기</button></div>

        ${syncSectionHtml()}
        ${calendarSectionHtml()}

        <div class="field"><span class="label">플래너 이름</span><input type="text" name="title" value="${esc(s.title)}"></div>
        <div class="field">
            <span class="label">하루 시작 시각</span>
            <select name="startHour">${hourOptions}</select>
            <p class="hint">시간표 첫 줄의 시각입니다. 오후로 정하면 그 이후 칸은 <b>전날 밤</b>으로 계산돼요.</p>
        </div>

        <p class="section-title">🔔 알림 <span class="status-pill${status === '켜짐' ? ' on' : ''}">${status}</span></p>
        <div class="field">
            <div class="btn-row">
                ${granted && s.notify.enabled
        ? '<button type="button" class="btn" data-set="notify-off">알림 끄기</button>'
        : '<button type="button" class="btn ok" data-set="notify-on">알림 켜기</button>'}
                <button type="button" class="btn" data-set="notify-test"${granted ? '' : ' disabled'}>테스트 알림</button>
            </div>
            <label class="label-row"><span class="label">알림 시점</span></label>
            <select name="lead">${leadOptions}</select>
            <p class="hint">ACTION·PLAN이 적힌 칸이 시작될 때 알려드려요. 완료 체크한 칸은 건너뜁니다.<br>
            브라우저 알림은 <b>플래너가 열려 있거나 백그라운드에 있을 때</b> 울려요.
            ${isIos() ? '<br>iPhone: Safari 공유 버튼 → <b>홈 화면에 추가</b> → 추가된 앱에서 알림 켜기 (iOS 16.4 이상).' : ''}<br>
            앱을 완전히 닫아도 받으려면 아래 <b>캘린더로 내보내기</b>를 쓰세요 (캘린더 앱이 알려줍니다).</p>
        </div>

        <p class="section-title">📅 캘린더로 내보내기</p>
        <div class="btn-row">
            <button type="button" class="btn" data-set="ics-1">이 날 일정</button>
            <button type="button" class="btn" data-set="ics-7">이 날부터 7일</button>
        </div>

        <p class="section-title">🗂 기본 계획</p>
        <p class="hint">기본 계획을 저장해 두면 새 날짜를 열 때 자동으로 채워져요. ${state.template ? '<b>저장된 기본 계획 있음</b>' : '아직 없음'}</p>
        <div class="btn-row">
            <button type="button" class="btn" data-set="tpl-save">이 날 계획을 기본으로 저장</button>
            <button type="button" class="btn" data-set="copy-prev">전날 계획 불러오기</button>
            ${state.template ? '<button type="button" class="btn" data-set="tpl-apply">기본 계획 적용</button><button type="button" class="btn danger" data-set="tpl-clear">기본 계획 삭제</button>' : ''}
        </div>

        <p class="section-title">💾 백업</p>
        <p class="hint">데이터는 이 기기 브라우저에만 저장돼요. 다른 기기로 옮기거나 보관하려면 백업 파일을 쓰세요.</p>
        <div class="btn-row">
            <button type="button" class="btn" data-set="backup">백업 파일 저장</button>
            <button type="button" class="btn" data-set="restore">백업 불러오기</button>
            <input type="file" accept="application/json,.json" class="visually-hidden" name="restoreFile" tabindex="-1">
        </div>
        <button type="button" class="btn danger" data-set="reset-day">이 날 기록 모두 지우기</button>`;
    updateSyncStatus();
    updateCalendarStatus();
}

function copyRowsFrom(sourceRows) {
    day().rows = emptyDay(toTemplate(sourceRows)).rows;
}

$('#settingsBtn').addEventListener('click', () => {
    buildSettingsForm();
    $('#settingsSheet').showModal();
});

$('#settingsForm').addEventListener('change', (e) => {
    const t = e.target;
    if (t.name === 'title') {
        state.settings.title = t.value.trim() || defaultState().settings.title;
        save('meta');
    } else if (t.name === 'calendarUrls') {
        state.settings.calendarUrls = t.value.split(/\s+/).map((u) => u.trim()).filter((u) => /^(webcals?|https?):\/\//i.test(u));
        save('meta');
        updateCalendarStatus();
        toast(state.settings.calendarUrls.length ? '캘린더 링크를 저장했어요. 30분 안에 일정이 들어와요' : '캘린더 가져오기를 껐어요');
        return;
    } else if (t.name === 'startHour') {
        state.settings.startHour = Number(t.value);
        save('meta');
    } else if (t.name === 'lead') {
        state.settings.notify.lead = Number(t.value);
        save('none');
    } else if (t.name === 'restoreFile' && t.files[0]) {
        importBackup(t.files[0]);
    } else {
        return;
    }
    render();
});

$('#settingsForm').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-set]');
    if (!btn) return;
    const action = btn.dataset.set;
    let scope = 'day';
    const replaceDay = (msg) => {
        const hasData = day().rows.some((r) => r.action || r.plan || r.cat);
        return !hasData || window.confirm(msg);
    };
    switch (action) {
    case 'notify-on':
        enableNotifications();
        return;
    case 'notify-off':
        state.settings.notify.enabled = false;
        scope = 'none';
        break;
    case 'notify-test':
        showNotification('테스트 알림', `${hourLabel(new Date().getHours())} · 알림이 잘 오고 있어요`, 'test');
        return;
    case 'ics-1':
        exportIcs(1);
        return;
    case 'ics-7':
        exportIcs(ICS_WEEK_DAYS);
        return;
    case 'tpl-save':
        state.template = toTemplate(day().rows);
        toast('기본 계획으로 저장했어요');
        scope = 'meta';
        break;
    case 'tpl-apply':
        if (!replaceDay('이 날 시간표를 기본 계획으로 덮어쓸까요?')) return;
        copyRowsFrom(state.template);
        break;
    case 'tpl-clear':
        state.template = null;
        scope = 'meta';
        break;
    case 'copy-prev': {
        const prev = state.days[addDays(currentKey, -1)];
        if (!prev) {
            toast('전날 기록이 없어요');
            return;
        }
        if (!replaceDay('이 날 시간표를 전날 계획으로 덮어쓸까요?')) return;
        copyRowsFrom(prev.rows);
        toast('전날 계획을 불러왔어요');
        break;
    }
    case 'backup':
        exportBackup();
        return;
    case 'restore':
        $('#settingsForm [name=restoreFile]').click();
        return;
    case 'reset-day':
        if (!window.confirm('이 날의 시간표·습관·운동·노트를 모두 지울까요?')) return;
        state.days[currentKey] = emptyDay();
        break;
    case 'sync-connect':
        connectSync();
        return;
    case 'sync-copy':
        copySyncToken();
        return;
    case 'sync-now':
        syncNow({ manual: true });
        return;
    case 'sync-disconnect':
        if (!window.confirm('이 기기의 동기화를 끊을까요? (기록은 이 기기와 Gist 양쪽에 그대로 남아요)')) return;
        writeSyncConfig(null);
        buildSettingsForm();
        return;
    default:
        return;
    }
    save(scope);
    render();
    buildSettingsForm();
});

// ---------- 시작 ----------

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // 자정을 넘겨 다시 열었을 때 어제에 머물지 않도록
    const today = toKey(new Date());
    if (render.openedOn && render.openedOn !== today && currentKey === render.openedOn) goTo(today);
    render.openedOn = today;
    tick();
    syncNow();
});

// 앱을 내릴 때 보내지 못한 변경을 바로 올린다
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && pushTimer) syncNow();
});
window.addEventListener('online', () => syncNow());
setInterval(() => {
    if (document.visibilityState === 'visible') syncNow();
}, SYNC_POLL_MS);

render.openedOn = currentKey;
// 처음 정해진 기본값(프로그램 시작일 등)을 바로 저장해 다음 주에 바뀌지 않게 한다
persistNow();
render();
tick();
syncNow();
setInterval(tick, TICK_INTERVAL_MS);
