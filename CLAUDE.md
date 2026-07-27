# 금시세 트래커 (gold-tracker)

국제 금·은 시세(XAU/XAG)를 원화로 환산해 보여주고, 사용자가 직접 입력한 매수 기록의 평가손익을 계산하는 정적 웹앱. 빌드 도구 없는 순수 HTML/CSS/JS(바닐라, IIFE 한 개), 서버 없음 — 모든 사용자 데이터는 `localStorage`에만 저장됨.

## 파일 구조
- `index.html` — 마크업 전체 (단일 페이지)
- `app.js` — 전체 로직 (시세 조회, 렌더링, SVG 차트, 폼) — 하나의 IIFE 안에 있음, 모듈 분리 없음
- `styles.css` — 전체 스타일, CSS 변수로 라이트/다크 테마 토큰 관리 (`:root`, `prefers-color-scheme`, `[data-theme]`)
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA(설치형 앱) 지원

## 데이터 흐름
- `refreshPrices()` — 1분마다 자동 호출. gold-api.com(XAU/XAG) + frankfurter.app/open.er-api.com(USD→KRW)에서 실시간 시세를 받아 `prices`에 저장하고 `recordSnapshot()` 호출
- `recordSnapshot()` — 매 조회 시점의 {시각, 금시세, 은시세, 환율}을 `snapshots` 배열(`localStorage['gold2.snapshots']`)에 누적. 5분 이내 재조회는 마지막 점을 덮어씀. 이 배열이 "오늘 시간대별" 차트와 "자산 추이" 차트의 데이터 원천 — **앱이 열려 있는 동안에만 쌓임** (외부에 분 단위 과거 시세 API가 없어서 그렇게 설계함)
- `fetchGoldHistory()` — 하루 한 번, NBP(폴란드 중앙은행) API에서 최근 365일 금 고시가(PLN/g) + PLN→KRW 환율을 받아 `goldHist`(`localStorage['gold2.goldHistory']`)에 캐시. 1개월/3개월/1년 차트와 "전일 대비" 계산의 기준

## 최근 작업 (2026-07-27 세션)

### 추가한 기능
1. **"오늘" 시간대별 시세 탭** — 순금 시세 차트의 기간 선택(1개월/3개월/1년) 앞에 "오늘" 버튼 추가. 선택 시 `goldHist`(일별) 대신 `snapshots`(로컬 누적분)를 오늘 날짜로 필터링해 시:분 단위로 그림. 관련 함수: `todaySnapshotPoints()`, `hhmm()`, `isoOf()`, `renderGoldTrend()`의 `isDay` 분기.
   - 한계: 오늘 처음 앱을 열면 점이 1개뿐이라 "기록 부족" 안내가 뜸. 앱을 켜둔 채 1분 간격 자동 새로고침이 쌓여야 그래프가 그려짐.

2. **"전일 대비" 가격 차이 표시** — 순금 1g/1돈, 은 1g, 원/달러 환율 카드 아래에 전일 대비 증감액(₩)과 %를 색상(상승/하락)과 함께 표시.
   - 금: `yesterdayGoldClose()` — `goldHist`에서 오늘 이전 가장 최근 날짜의 종가 사용 (신뢰도 높음, NBP 공식 고시가)
   - 은/환율: `snapshotAround(24h, ±8h)` — NBP 등 공식 전일 고시가가 없어서 로컬 스냅샷 중 24시간 전과 가장 가까운 것을 대신 사용 (앱을 하루 이상 켜둔 적 없으면 표시 안 됨 — 정상 동작)
   - 관련 함수: `appendDayDiff()`, `renderPrices()`

### 고친 버그
- `init()`에서 `fetchGoldHistory()` 완료 후 `renderGoldTrend()`만 다시 그렸는데, "전일 대비"가 `goldHist`에 의존하므로 `renderPrices()`도 같이 호출하도록 수정 (`app.js` 약 1483번째 줄). 안 고치면 페이지 첫 로딩 시 "전일 대비"가 1분 뒤에나 나타남.

### 미커밋 상태
`app.js`, `index.html`이 수정된 채 **커밋도 push도 안 됨** (사용자가 커밋을 명시적으로 요청하지 않아서 보류 중). 다음 세션에서 이어받으면 `git diff`로 변경 내용 확인 후 커밋 여부를 사용자에게 확인할 것.

## 배포 (Vercel)
- 2026-07-27에 **최초로** Vercel에 배포함. 계정: `parao0802` (teamId `team_2MdHD6KWpCSOyyo9yzJkJbRS`), 프로젝트명 `gold-tracker`
- **프로덕션 URL**: https://gold-tracker-parao0802.vercel.app
- **GitHub 저장소와 연결되어 있지 않음** — `deploy_to_vercel` MCP 툴로 로컬 파일을 직접 업로드한 것. 즉 GitHub에 push해도 자동 재배포 안 됨. 다시 배포하려면 같은 MCP 툴로 파일을 다시 올리거나, Vercel 대시보드에서 이 프로젝트를 GitHub 저장소(`parao0802-ux/gold-tracker`)와 연결해야 함 (사용자에게 git 연동 여부를 물어봤으나 아직 답 없음)
- `icons/icon-192.png`는 이번 배포에 **포함 안 됨** (base64라 용량이 커서 생략) — `icons/icon.svg`만 파비콘/매니페스트 아이콘으로 사용 중. 기능엔 지장 없으나 iOS/Android 홈 화면 아이콘 모양이 SVG 렌더링으로 나올 수 있음

## 안드로이드 설치형 앱 관련
- 사용자가 "어제" 안드로이드 폰에 PWA를 설치했다고 하는데, 그 시점엔 이 프로젝트가 Vercel에 배포되기 전이라 **어떤 주소를 가리키고 있었는지 알 수 없음** (사용자도 기억 못 함). 위 프로덕션 URL로 재설치하도록 안내함.
- `sw.js`는 같은 출처 요청에 대해 stale-while-revalidate 캐싱을 씀 — 배포 직후엔 캐시된 이전 화면이 한 번 보이고, 백그라운드 갱신 후 재실행하면 반영됨. 캐시 버전은 `sw.js`의 `CACHE = 'gold-tracker-v1'` — 강제 무효화하려면 이 문자열을 올려야 함 (현재는 안 올림)

## 알려진 한계 (설계상 의도된 것, 버그 아님)
- 은/환율은 일별 공식 과거 시세 API가 없어서 "전일 대비"가 로컬 스냅샷에 의존 — 새 기기/새 브라우저에서는 한동안 표시 안 됨
- "오늘" 차트도 같은 이유로 로컬 누적 데이터에 의존
