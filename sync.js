// GitHub 비공개 Gist 를 기기 간 공용 저장소로 쓴다. 병합 규칙은 core.js 의 mergeStates
const API = 'https://api.github.com';
const FILE_NAME = 'planner-data.json';
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

export async function readGist(token, gistId) {
    const gist = await request(token, `/gists/${gistId}`);
    const file = gist.files?.[FILE_NAME];
    if (!file) return null;
    // 1MB 를 넘으면 API 응답에서 잘리므로 원본 주소로 다시 받는다
    const text = file.truncated
        ? await fetch(file.raw_url, { cache: 'no-store' }).then((r) => r.text())
        : file.content;
    try {
        return JSON.parse(text);
    } catch {
        throw new SyncError('동기화 데이터가 손상되었어요', 0);
    }
}

export async function writeGist(token, gistId, payload) {
    await request(token, `/gists/${gistId}`, {
        method: 'PATCH',
        body: JSON.stringify({ files: { [FILE_NAME]: { content: JSON.stringify(payload) } } }),
    });
}
