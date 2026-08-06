# 금시세 트래커 (gold-tracker)

국제 금·은 시세(XAU/XAG)를 원화로 환산해 보여주고, 사용자가 직접 입력한 매수 기록의 평가손익을 계산하는 정적 웹앱. 빌드 도구 없는 순수 HTML/CSS/JS(바닐라, IIFE 한 개), 서버 없음 — 모든 사용자 데이터는 `localStorage`에만 저장됨.

## 🔜 진행 중 — KRX 시세로 평가 기준 교체 (2026-08-06 중단, 키 발급 대기)

**사용자 요청**: 평가손익 기준을 지금의 한국금거래소 매입가 → **한국거래소(KRX) 금시장 시세**로 바꾸기.

### 왜 값이 다른가 (이미 조사 끝, 다시 조사하지 말 것)
`한국금거래소`(koreagoldx.co.kr, 민간 딜러) ≠ `한국거래소`(KRX, 공식 거래소). 2026-08-06 실측 1g 기준:

| 출처 | 1g | 국제 대비 |
|---|---|---|
| 국제 현물 | ₩195,143 | — |
| **KRX 금시장** (사용자가 원하는 값) | ₩194,280 | −0.4% |
| 한국금거래소 팔 때 ← **현재 앱이 쓰는 값** | ₩189,600 | −2.4% (딜러 매입 마진) |
| 한국금거래소 살 때 | ₩228,533 | +17% (세공비·부가세) |

### 막힌 경로 (재시도 무의미)
- **data.krx.co.kr 직접 호출 → 불가.** 2026-08-06 기준 사이트 전체가 로그인 뒤로 이동. 세션 쿠키를 붙여도 `getJsonData.cmd`가 `LOGOUT`만 반환하고, 브라우저로 열면 로그인 페이지로 리다이렉트됨
- **네이버 금융 → 불가.** `marketindex`에 국제 금(`CMDT_GC`)만 있고 국내 KRX 없음

### 유일한 경로: 공공데이터포털
- API: [금융위원회_일반상품시세정보](https://www.data.go.kr/data/15094805/openapi.do) (KRX 금시장 포함, 무료, **갱신 하루 1회 = 전일 종가**)
- 사용자가 인증키 발급 중. **키를 대화나 코드에 넣지 말 것** — Vercel 환경변수 `DATA_GO_KR_KEY`로 등록하고 코드는 `process.env.DATA_GO_KR_KEY`로만 읽는다
- 환경변수 등록은 대시보드에서만 가능 (MCP에 env 관리 툴 없음): https://vercel.com/parao0802/gold-tracker/settings/environment-variables
- ⚠️ `data.go.kr`은 **개발 환경에서 차단됨**(ECONNREFUSED). 응답 형식 검증은 배포된 icn1 함수로 해야 함

### 키가 준비되면 할 일
1. `api/` 에 KRX 시세 엔드포인트 추가 (기존 `domestic-gold.js` 패턴 그대로 — 서울 리전 필수)
2. `currentRates()`(app.js ~152행)가 KRX 값을 쓰도록 교체. `intlRates()`는 그대로 둘 것
3. `recordSnapshot()`의 `dg`/`ds`도 KRX 기준으로 맞출지 결정 — 안 맞추면 자산 추이 그래프에 단차 생김
4. 화면 문구 수정: 현재 "국내 '팔 때' 시세 기준"이라 적혀 있는 곳들(`index.html`의 `h-dash` 아래 `section-sub`, 국내 섹션 `section-sub`, 차트 제목 옆 `팔 때 기준` 배지)

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
- `fetchDomestic()` — 국내 현재 고시가 + 오늘 시각별. `/api/domestic-gold`에서 받아 `domestic`(`localStorage['gold2.domestic']`)에 10분 TTL로 캐시
- `fetchDomesticHistory()` — 국내 1년 일별 이력. `/api/domestic-gold?range=year`에서 받아 `domHist`(`localStorage['gold2.domesticHistory']`)에 하루 1회 캐시. **상단 차트의 데이터 원천**

## 국내 시세 (한국금거래소)

- 원본: `POST https://www.koreagoldx.co.kr/api/price/chart/list`, body `{srchDt:'1', type:'Au', dataDateStart:'YYYY.MM.DD', dataDateEnd:'YYYY.MM.DD'}`
  - 응답 `list[]`는 **최신순**. 필드: `s_pure`/`p_pure`(순금 살때/팔때, **1돈=3.75g 기준**), `s_silver`/`p_silver`(은), `p_18k`, `p_14k`, `date`(시각 포함)
  - 하루 여러 차례 갱신됨 (공공데이터포털 "일반상품시세정보"는 하루 1회라 이쪽을 택함)
  - 1년 범위도 그대로 받아짐(약 201KB, 314일치). 프록시가 날짜별 마지막 값만 남겨 **13KB로 줄여서** 내려줌

### 프록시 엔드포인트 (`api/domestic-gold.js`)
| 요청 | 응답 | 엣지 캐시 |
|---|---|---|
| `/api/domestic-gold` | `at`, `buy`, `sell`, `prevSell`, `today[]`(오늘 시각별) | 5분 |
| `/api/domestic-gold?range=year` | `history[]` = `{d,s,p}` 일별, 오래된 순 | 6시간 |

### 단위 규칙 (중요)
원본은 **전부 1돈(3.75g) 기준**이다. 화면은 국제 시세와 맞추려고 **1g을 기본 단위로** 쓰므로 `perGram()`으로 3.75를 나눠 표시하고, 1돈 금액은 카드의 둘째 줄에 따로 적는다. 차트 y축도 1g 기준.
- **CORS가 막혀 있어 브라우저에서 직접 호출 불가** (preflight 403, `Access-Control-Allow-Origin` 없음) → `api/domestic-gold.js` 서버리스 프록시 필수. 엣지에서 `s-maxage=300`으로 캐시해 원본 부하를 줄임
- `sw.js`가 같은 출처 GET을 캐시하므로 **`/api/`는 캐시 제외** 처리함 (안 하면 시세가 고정됨)
- 공식 API가 아니라 사이트 내부 엔드포인트라, 사이트 개편 시 깨질 수 있음. 깨지면 `renderDomestic()`은 조용히 넘어가고 국제 시세만 표시됨

### ⚠️ 반드시 서울(icn1) 리전에서 실행할 것
한국금거래소는 **Vercel 미국 리전(iad1) IP를 403으로 차단**한다. 로컬 curl은 헤더를 다 빼도 200이 나오는데 배포본만 403이라 헤더 문제로 오해하기 쉬움 — **IP 기반 차단**임.
`vercel.json`의 `{"regions":["icn1"]}`가 이걸 해결한다. **이 파일을 지우거나 리전을 바꾸면 국내 시세가 즉시 죽는다.**
(Hobby 플랜은 리전 1개만 지정 가능)

### 평가 기준 시세 (2026-08-06 변경, 중요)
**평가액·손익은 국내 '팔 때'(매입가) 기준으로 계산한다.** 지금 팔면 실제로 받는 금액이라야 손익이 의미가 있기 때문. 함수가 두 개로 나뉘어 있으니 헷갈리지 말 것:

| 함수 | 반환 | 쓰는 곳 |
|---|---|---|
| `currentRates()` | **국내 팔 때** 원/g | `summarize()`, `valueOf()`, `updateFormHint()` — 즉 **모든 평가·손익** |
| `intlRates()` | 국제 현물가 원/g | `renderPrices()`(국제 카드), `renderDomestic()`의 괴리율, `recordSnapshot()` |

- `currentRates()`는 국내 고시가를 아직 못 받았을 때만 `intlRates()`로 대체된다
- `recordSnapshot()`은 국제(`g`,`s`)와 국내(`dg`,`ds`)를 **둘 다** 적는다. `trendSeries()`는 `dg`/`ds`를 우선 쓰고 이 필드가 없는 옛 스냅샷만 국제 시세로 대체 — 평가 기준을 바꾸면서 자산 추이 그래프에 단차가 생기는 걸 막기 위함
- 국내 시세는 비동기로 늦게 도착하므로 `fetchDomestic().then(renderAll)`로 **대시보드까지** 다시 그려야 한다 (`renderDomestic()`만 부르면 평가손익이 1분간 국제 기준으로 남음)

### 살 때 / 팔 때 해석 (중요)
2026-08-06 실측: 살때 ₩857,000 · 팔때 ₩711,000 · 국제 현물 1돈 ₩731,922
- **살 때**(매장 판매가)는 세공비·부가세가 붙어 국제 대비 약 **+17%**
- **팔 때**(매장 매입가)는 딜러 마진이 빠져 국제 대비 약 **−2.9%** — 즉 "김치프리미엄"으로 국내가 항상 비싸다고 단정하면 틀림
- 괴리율 카드는 세공비가 없는 **팔 때 기준**으로 계산함 (`renderDomestic()`)
- **화면에 표시되는 국내 시세 금액은 전부 '팔 때'다.** 사용자 요청으로 '살 때' 카드는 제거함 (세금·세공비가 섞여 평가 기준과 어긋나서). 프록시는 여전히 `buy`를 내려주므로 필요하면 되살릴 수 있음

## 화면 구성 (2026-08-06 개편)

위에서부터: **① 국내 금시세 → ② 실시간 국제 시세 → ③ 투자 현황 → ④ 매수 기록**

- 국내·국제 두 섹션 모두 카드 4장을 **같은 순서**로 둔다: `순금 1g → 순금 1돈 → 은 1g → (국제 대비 | 원/달러 환율)`

- 차트는 **하나뿐**이고 국내 시세 섹션에 속한다. 데이터는 `domHist`(국내 팔 때, 1g). 기간 탭 `오늘/1개월/3개월/1년`
  - `오늘` 탭은 로컬 스냅샷이 아니라 **원본이 주는 시각별 고시가**(`domestic.today`)를 쓴다. 하루 2~4회만 고시되므로 오전엔 점이 1개뿐이라 안내문이 뜨는 게 정상
- `goldHist`(NBP)는 **더 이상 차트에 안 쓰인다.** 국제 시세 카드의 "전일 대비" 계산에만 쓰임 → NBP가 실패해도 국내 차트를 건드리지 않도록 `init()`에서 분리해 둠 (되돌리지 말 것)
- `snapshots`는 여전히 "자산 추이" 차트에만 쓰인다

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

### GitHub 연동 완료 (2026-08-06)
`parao0802-ux/gold-tracker` `main`에 push하면 **자동 배포됨**. 확인함 — 배포 `meta`에 `githubCommitSha`가 붙고 `lambdaRuntimeStats:{"nodejs":1}`로 서버리스 함수도 빌드됨.
이제 `deploy_to_vercel` MCP 툴을 쓸 이유가 없음 — **그냥 push할 것.** (아래 괴리 문제도 이걸로 해소됨)

### 과거 이슈: 프로덕션 코드가 저장소와 달랐던 건 (해소됨)
- 2026-07-27 배포는 `deploy_to_vercel` MCP 툴로 파일 내용을 **인라인**해 올렸는데, `app.js`가 60KB라 인라인이 안 되어 **손으로 압축한 축약본**을 올렸음. 즉 프로덕션의 `app.js` ≠ 저장소의 `app.js` (기능은 같지만 주석·포맷이 다름)
- 같은 이유로 `icons/icon-192.png`도 배포에서 빠짐 (`icons/icon.svg`만 사용 중)
- GitHub 연동 후 저장소 코드가 그대로 배포되어 **해소 확인함** (배포된 `app.js` 58,934 bytes = 저장소 원본)
- `icons/icon-192.png`도 이제 정상 배포됨
- MCP 툴로는 git 연결을 할 수 없었음(GitHub OAuth 필요) → 대시보드에서 사용자가 수동으로 연결: https://vercel.com/parao0802/gold-tracker/settings/git
- 이 머신엔 **Node.js/npm이 없음** → `vercel` CLI, 로컬 서버리스 함수 테스트 불가. 정적 파일만 PowerShell `HttpListener`로 띄워 테스트했음

## 안드로이드 설치형 앱 관련
- 사용자가 "어제" 안드로이드 폰에 PWA를 설치했다고 하는데, 그 시점엔 이 프로젝트가 Vercel에 배포되기 전이라 **어떤 주소를 가리키고 있었는지 알 수 없음** (사용자도 기억 못 함). 위 프로덕션 URL로 재설치하도록 안내함.
- `sw.js`는 같은 출처 요청에 대해 stale-while-revalidate 캐싱을 씀 — 배포 직후엔 캐시된 이전 화면이 한 번 보이고, 백그라운드 갱신 후 재실행하면 반영됨. 캐시 버전은 `sw.js`의 `CACHE = 'gold-tracker-v1'` — 강제 무효화하려면 이 문자열을 올려야 함 (현재는 안 올림)

## 알려진 한계 (설계상 의도된 것, 버그 아님)
- 은/환율은 일별 공식 과거 시세 API가 없어서 "전일 대비"가 로컬 스냅샷에 의존 — 새 기기/새 브라우저에서는 한동안 표시 안 됨
- "오늘" 차트도 같은 이유로 로컬 누적 데이터에 의존
- 국내 시세는 `/api` 프록시가 필요해 **로컬 정적 서버에서는 404** — 콘솔에 경고만 남기고 국제 시세는 정상 동작. 실제 확인은 배포본에서 해야 함
