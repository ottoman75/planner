# 4X 플래너 (웹)

@intend.md

## 개요
종이 4X 플래너 양식을 옮긴 정적 PWA. 빌드 없음, 서버 없음, 데이터는 브라우저 localStorage(`planner.v1`).
배포: GitHub Pages (`main` 브랜치 루트) → https://ottoman75.github.io/planner/

## 구조
- `core.js` — 순수 도메인 로직(병합 레이아웃, 통계, 날짜, 알림 일정, .ics). DOM 금지
- `app.js` — 렌더링·이벤트·알림 틱·설정. 계산은 반드시 `core.js` 를 거친다 (같은 로직 두 벌 금지)
- `fitness-program.js` — 8주 운동 프로그램 표와 날짜→그날 목표 계산(순수). 기록 키는 `pg:` 접두사로 사용자 운동 id 와 분리
- `sync.js` — GitHub Gist API 호출만. 병합 규칙은 `core.js` 의 `mergeStates`
- `sw.js` — 앱 셸 캐시(네트워크 우선) + 알림 클릭 처리. GitHub API 응답은 캐시하지 않는다
- `tests/*.test.js` — `npm test` (node --test)

## 작업 규칙
- 정적 파일을 바꾸면 `sw.js` 의 `VERSION` 을 올린다
- 데이터를 바꾸면 `save(scope)` 의 scope 를 맞게 준다 — 'day'(보고 있는 날) / 'meta'(습관·운동·설정·기본 계획) / 'none'(기기 전용). 틀리면 그 변경이 다른 기기로 안 간다
- 동기화 토큰은 `planner.sync` 에만 둔다. 백업 파일(`planner.v1`)에 섞지 말 것
- 동기화 수동 검증: 로컬 목 Gist 서버 + `localhost` / `127.0.0.1` 두 오리진을 두 기기로 쓴다 (실제 토큰 사용 금지)
- 저장 데이터 스키마는 필드를 **추가만** 한다. `loadState()` 가 기본값과 병합하므로 키 이름을 바꾸지 말 것
- 로컬 확인: `npm start` (또는 `python3 -m http.server 5173`) 후 http://localhost:5173 (5173 이 다른 프로젝트에 잡혀 있으면 다른 포트)
- 모바일 폭(390px)에서 가로 스크롤이 생기지 않는지 확인한다. 그리드 열은 `minmax(0, 1fr)` 로
- 공개 저장소다. 개인 기록·실데이터를 코드나 테스트에 넣지 않는다

## 알려진 제약
- 동기화는 하루 단위 last-write-wins. 같은 날을 동기화 사이에 두 기기에서 고치면 한쪽이 사라진다
- 웹 알림은 앱이 열려 있거나 백그라운드일 때만. 완전히 닫혀 있으면 캘린더(.ics) 내보내기로 대체
- iPhone 은 홈 화면에 추가한 앱(iOS 16.4+)에서만 알림 권한을 요청할 수 있다
