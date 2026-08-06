# 금시세 트래커 (gold-tracker)

국제 금·은 시세(XAU/XAG)를 원화로 환산해 보여주고, 사용자가 직접 입력한 매수 기록의 평가손익을 계산하는 정적 웹앱. 빌드 도구 없는 순수 HTML/CSS/JS(바닐라, IIFE 한 개), 서버 없음 — 모든 사용자 데이터는 `localStorage`에만 저장됨.

## 파일 구조
- `index.html` — 마크업 전체 (단일 페이지)
- `app.js` — 전체 로직 (시세 조회, 렌더링, SVG 차트, 폼) — 하나의 IIFE 안에 있음, 모듈 분리 없음
- `styles.css` — 전체 스타일, CSS 변수로 라이트/다크 테마 토큰 관리 (`:root`, `prefers-color-scheme`, `[data-theme]`)
- `api/domestic-gold.js` — Vercel 서버리스 함수. 한국금거래소 고시가 프록시 (아래 "국내 시세" 참고)
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA(설치형 앱) 지원
- `apps-script/` — **이 작업과 무관한 사용자의 기존 미커밋 폴더.** 건드리지 말 것

## 데이터 흐름
- `refreshPrices()` — 1분마다 자동 호출. gold-api.com(XAU/XAG) + frankfurter.app/open.er-api.com(USD→KRW)에서 실시간 시세를 받아 `prices`에 저장하고 `recordSnapshot()` 호출
- `recordSnapshot()` — 매 조회 시점의 {시각, 금시세, 은시세, 환율}을 `snapshots` 배열(`localStorage['gold2.snapshots']`)에 누적. 5분 이내 재조회는 마지막 점을 덮어씀. 이 배열이 "오늘 시간대별" 차트와 "자산 추이" 차트의 데이터 원천 — **앱이 열려 있는 동안에만 쌓임** (외부에 분 단위 과거 시세 API가 없어서 그렇게 설계함)
- `fetchGoldHistory()` — 하루 한 번, NBP(폴란드 중앙은행) API에서 최근 365일 금 고시가(PLN/g) + PLN→KRW 환율을 받아 `goldHist`(`localStorage['gold2.goldHistory']`)에 캐시. 1개월/3개월/1년 차트와 "전일 대비" 계산의 기준
- `fetchDomestic()` — 국내 고시가. `/api/domestic-gold` 프록시를 통해 받아 `domestic`(`localStorage['gold2.domestic']`)에 10분 TTL로 캐시

## 국내 시세 (한국금거래소)

- 원본: `POST https://www.koreagoldx.co.kr/api/price/chart/list`, body `{srchDt:'1', type:'Au', dataDateStart:'YYYY.MM.DD', dataDateEnd:'YYYY.MM.DD'}`
  - 응답 `list[]`는 **최신순**. 필드: `s_pure`/`p_pure`(순금 살때/팔때, **1돈=3.75g 기준**), `s_silver`/`p_silver`(은), `p_18k`, `p_14k`, `date`
  - 하루 여러 차례 갱신됨 (공공데이터포털 "일반상품시세정보"는 하루 1회라 이쪽을 택함)
- **CORS가 막혀 있어 브라우저에서 직접 호출 불가** (preflight 403, `Access-Control-Allow-Origin` 없음) → `api/domestic-gold.js` 서버리스 프록시 필수. 엣지에서 `s-maxage=300`으로 캐시해 원본 부하를 줄임
- `sw.js`가 같은 출처 GET을 캐시하므로 **`/api/`는 캐시 제외** 처리함 (안 하면 시세가 고정됨)
- 공식 API가 아니라 사이트 내부 엔드포인트라, 사이트 개편 시 깨질 수 있음. 깨지면 `renderDomestic()`은 조용히 넘어가고 국제 시세만 표시됨

### 살 때 / 팔 때 해석 (중요)
2026-08-06 실측: 살때 ₩857,000 · 팔때 ₩711,000 · 국제 현물 1돈 ₩731,922
- **살 때**(매장 판매가)는 세공비·부가세가 붙어 국제 대비 약 **+17%**
- **팔 때**(매장 매입가)는 딜러 마진이 빠져 국제 대비 약 **−2.9%** — 즉 "김치프리미엄"으로 국내가 항상 비싸다고 단정하면 틀림
- 괴리율 카드는 세공비가 없는 **팔 때 기준**으로 계산함 (`renderDomestic()`)
- 평가손익 계산 자체는 여전히 **국제 시세 기준**. 사용자가 "둘 다 보여주기"를 택해 표시만 추가한 것

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

### 커밋 상태
2026-08-06 기준 모두 커밋·push 완료 (`main`). git 신원은 `parao0802 / parao0802@gmail.com`.

## 배포 (Vercel)
- 계정: `parao0802` (teamId `team_2MdHD6KWpCSOyyo9yzJkJbRS`), 프로젝트 `gold-tracker` (projectId `prj_WJYeh9pd9F7w2t8VjKO0e7S7suZe`)
- **프로덕션 URL**: https://gold-tracker-parao0802.vercel.app

### ⚠️ 프로덕션 코드가 저장소와 다름 (해소 진행 중)
- 2026-07-27 배포는 `deploy_to_vercel` MCP 툴로 파일 내용을 **인라인**해 올렸는데, `app.js`가 60KB라 인라인이 안 되어 **손으로 압축한 축약본**을 올렸음. 즉 프로덕션의 `app.js` ≠ 저장소의 `app.js` (기능은 같지만 주석·포맷이 다름)
- 같은 이유로 `icons/icon-192.png`도 배포에서 빠짐 (`icons/icon.svg`만 사용 중)
- **해결책 = GitHub 연동.** 연동되면 저장소 코드가 그대로 배포되어 이 괴리가 사라지고, MCP 인라인 업로드를 다시 쓸 일이 없음
- 2026-08-06: 사용자가 Vercel↔GitHub 연결을 했다고 함. 프로젝트 `updatedAt`은 갱신됐으나 **git 트리거 배포는 아직 확인 안 됨**. 확인 방법: `list_deployments`로 배포의 `meta`에 `githubCommitSha` 등이 붙는지 볼 것 (수동 업로드 배포는 `meta: {}`)
- MCP 툴로는 git 연결을 할 수 없음(GitHub OAuth 필요) → 대시보드에서 수동으로만 가능: https://vercel.com/parao0802/gold-tracker/settings/git
- 이 머신엔 **Node.js/npm이 없음** → `vercel` CLI, 로컬 서버리스 함수 테스트 불가. 정적 파일만 PowerShell `HttpListener`로 띄워 테스트했음

## 안드로이드 설치형 앱 관련
- 사용자가 "어제" 안드로이드 폰에 PWA를 설치했다고 하는데, 그 시점엔 이 프로젝트가 Vercel에 배포되기 전이라 **어떤 주소를 가리키고 있었는지 알 수 없음** (사용자도 기억 못 함). 위 프로덕션 URL로 재설치하도록 안내함.
- `sw.js`는 같은 출처 요청에 대해 stale-while-revalidate 캐싱을 씀 — 배포 직후엔 캐시된 이전 화면이 한 번 보이고, 백그라운드 갱신 후 재실행하면 반영됨. 캐시 버전은 `sw.js`의 `CACHE = 'gold-tracker-v1'` — 강제 무효화하려면 이 문자열을 올려야 함 (현재는 안 올림)

## 알려진 한계 (설계상 의도된 것, 버그 아님)
- 은/환율은 일별 공식 과거 시세 API가 없어서 "전일 대비"가 로컬 스냅샷에 의존 — 새 기기/새 브라우저에서는 한동안 표시 안 됨
- "오늘" 차트도 같은 이유로 로컬 누적 데이터에 의존
- 국내 시세는 `/api` 프록시가 필요해 **로컬 정적 서버에서는 404** — 콘솔에 경고만 남기고 국제 시세는 정상 동작. 실제 확인은 배포본에서 해야 함
