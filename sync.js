// GitHub 비공개 Gist 를 기기 간 공용 저장소로 쓴다. 병합 규칙은 core.js 의 mergeStates
const API = 'https://api.github.com';
const FILE_NAME = 'planner-data.json';
// GitHub Actions(scripts/fetch-calendar.mjs)가 쓰는 캘린더 일정 파일. 앱은 읽기만 한다
const CALENDAR_FILE = 'planner-calendar.json';
const DESCRIPTION = '4X 플래너 동기화 데이터 (자동 생성 — 삭제하면 동기화가 끊깁니다)';
const LIST_PAGE_SIZE = 100;

export class SyncError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
    }
}

async function request(token, path, options = {}) {
    let response;
    try {
        response = await fetch(`${API}${path}`, {
            ...options,
            cache: 'no-store',
            headers: {
                Accept: 'application/vnd.github+json',
                Authorization: `Bearer ${token}`,
                ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            },
        });
    } catch {
        throw new SyncError('네트워크에 연결할 수 없어요', 0);
    }
    if (response.status === 401) throw new SyncError('토큰이 유효하지 않아요. 새 토큰으로 다시 연결해 주세요', 401);
    if (response.status === 403 || response.status === 404) {
        throw new SyncError('Gist 권한이 없어요. 토큰에 gist 권한이 있는지 확인해 주세요', response.status);
    }
    if (!response.ok) throw new SyncError(`GitHub 오류 (${response.status})`, response.status);
    return response.json();
}

// 이미 다른 기기가 만든 Gist 가 있으면 그것을, 없으면 null
export async function findGist(token) {
    const gists = await request(token, `/gists?per_page=${LIST_PAGE_SIZE}`);
    return gists.find((g) => g.files?.[FILE_NAME])?.id ?? null;
}

export async function createGist(token, payload) {
    const gist = await request(token, '/gists', {
        method: 'POST',
        body: JSON.stringify({
            description: DESCRIPTION,
            public: false,
            files: { [FILE_NAME]: { content: JSON.stringify(payload) } },
        }),
    });
    return gist.id;
}

// 1MB 를 넘으면 API 응답에서 잘리므로 원본 주소로 다시 받는다
async function fileText(file) {
    if (!file) return null;
    return file.truncated ? fetch(file.raw_url, { cache: 'no-store' }).then((r) => r.text()) : file.content;
}

/** 한 번의 요청으로 플래너 데이터와 캘린더 일정을 함께 읽는다 → { data, calendar } */
export async function readGist(token, gistId) {
    const gist = await request(token, `/gists/${gistId}`);
    const dataText = await fileText(gist.files?.[FILE_NAME]);
    let data = null;
    if (dataText) {
        try {
            data = JSON.parse(dataText);
        } catch {
            throw new SyncError('동기화 데이터가 손상되었어요', 0);
        }
    }
    let calendar = null;
    try {
        calendar = JSON.parse(await fileText(gist.files?.[CALENDAR_FILE]) ?? 'null');
    } catch {
        // 캘린더 파일이 깨져도 플래너 동기화는 계속한다
    }
    return { data, calendar };
}

export async function writeGist(token, gistId, payload) {
    await request(token, `/gists/${gistId}`, {
        method: 'PATCH',
        body: JSON.stringify({ files: { [FILE_NAME]: { content: JSON.stringify(payload) } } }),
    });
}
