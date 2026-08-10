# 쇼핑커넥트 수익화 퍼널 (Shopping Connect Funnel)

네이버 쇼핑커넥트 수익화 4단계 세일즈 퍼널. **한 레포에서 정적(static) 다중 페이지**로 배포합니다.

## 📌 현재 진행 상황 (2026-08-11)

**라이브**: https://njob.vercel.app · **GitHub**: carryhada/salesfunnel

| 항목 | 상태 |
|---|---|
| 4단계 랜딩 (`/` → `/watch` → `/consult` → `/apply` → `/done`) | ✅ 배포·검증 완료 |
| 토큰 기반 시트 트래킹 (1인 1행 UPSERT) | ✅ 옵트인·재생·도달·클릭·신청 전 구간 확인 |
| 확인문자(신청/예약완료) · 스티비 · 메타픽셀 | ✅ |
| 2차 문자 분류·발송 (A 미시청 / B 중도이탈 / C 도달·미신청) | ✅ 코드 완료, **솔라피 잔액 충전만 남음** |

**바로 다음에 할 일**
1. 솔라피 캐시 충전 → 시트 메뉴 `2차문자 → ② 테스트 발송`으로 문구 확인 (건당 약 45원/LMS)
2. `watch/index.html`의 `UNLOCK_SECONDS` 를 **테스트 15초 → 운영값**으로 변경
   (영상 교체 예정: 15~20분 촬영 후 `VIDEO_ID`와 `Remind.gs`의 `KEY_POINT`도 함께 수정)
3. 푸터 사업장 주소·전화번호 채우기, `/consult` 후기(✏️) 실제 내용으로 교체
4. (선택) `/api/segments` 자동화하려면 Code.gs 최신본으로 **새 버전 재배포** + Vercel `SEGMENTS_KEY` 설정

**주의**
- Apps Script 수정 후에는 **배포 관리 → ✏️ → 새 버전**으로만 재배포 (URL 유지). "새 배포"는 URL이 바뀜
- `Remind.gs`(시트 메뉴)는 저장만 하면 적용되고 재배포 불필요
- 웹앱 URL·시크릿은 Vercel 환경변수 `SHEETS_WEBHOOK_URL` / `SHEETS_SECRET` 에 있음

## 퍼널 구조

| 단계 | 파일 | 배포 URL | 역할 |
|---|---|---|---|
| 1차 | `index.html` | `/` | **옵트인** — 무료특강 신청(DB 수집 → 스티비) |
| 2차 | `watch/index.html` | `/watch` | **무료특강 영상**(VSL) |
| 3차 | `offer/index.html` | `/offer` | **세일즈·오퍼**(챌린지 33만 / 프리미엄 99만) |
| 4차 | `apply/index.html` | `/apply` | **신청·1:1 상담예약**(DB 수집 → 스티비) |
| 부속 | `privacy.html` | `/privacy` | 개인정보처리방침 |

흐름: `/` → `/watch` → `/offer` → `/apply`
짧은 링크: `/1 /2 /3 /4` 도 각 단계로 리다이렉트됩니다 (`vercel.json`).

## 폴더 구조
```
.
├── index.html            # 1차
├── watch/index.html      # 2차
├── offer/index.html      # 3차
├── apply/index.html      # 4차
├── privacy.html
├── assets/css/common.css # 공용 디자인 시스템(색·폰트·컴포넌트)
├── vercel.json           # cleanUrls · 리다이렉트 · 캐시 헤더
└── README.md
```

## 수정 가이드
- **색·폰트·버튼 스타일**: `assets/css/common.css` 한 곳만 고치면 전 페이지 반영.
- **스티비 리스트 변경**: 각 폼의 `STIBEE_ENDPOINT`(`index.html`, `apply/index.html`)에서 `lists/....` 값 교체.
- **무료특강 영상 삽입**: `watch/index.html`의 `<div class="video-box">` 안 iframe 주석 해제 후 유튜브 `VIDEO_ID` 입력.
- **사업자 정보**: 각 페이지 `<footer>`의 상호/사업자등록번호/주소/연락처 및 `privacy.html` 채우기.

## 확인문자 자동발송 (Solapi 솔라피)
1차 폼 제출 시 → 스티비 등록 + **확인문자(SMS/LMS) 자동발송**.
문자는 브라우저에서 직접 못 보내므로(키 노출·요금 위험) **서버리스 함수 `api/confirm-sms.js`** 가
솔라피(HMAC-SHA256 인증)를 호출합니다. 솔라피는 **IP 등록이 필요 없어** Vercel에서 바로 동작합니다.

Vercel → Project → Settings → **Environment Variables** 에 등록:
| 변수 | 값 |
|---|---|
| `SOLAPI_API_KEY` | 솔라피 API Key |
| `SOLAPI_API_SECRET` | 솔라피 API Secret |
| `SOLAPI_SENDER` | 사전등록한 발신번호(예: 01045114447) |
| `CONFIRM_SMS_ALLOWED_ORIGINS`(선택) | 커스텀 도메인 콤마구분 |

- 수신번호는 국가코드 없이 `0`으로 시작(자동 정규화됨). 90byte 초과 시 자동 LMS.
- 발신번호는 솔라피 콘솔에서 **사전등록** 필요(법적 의무).
- 남용/요금폭탄 방지: 솔라피에서 충전잔액·발송한도를 관리하세요.
- 문자 문구 수정: `api/confirm-sms.js`의 `text` 변수.

## 구글시트 자동 리스트업
1차 폼 제출 시 → 스티비/문자에 더해 **구글시트에 한 줄 자동 추가**.
서버리스 함수 `api/save-lead.js` 가 구글 Apps Script 웹앱으로 전달합니다(웹앱 URL·토큰은 서버에만 보관).

설치: `apps-script/Code.gs` 를 구글시트의 Apps Script에 붙여넣고 웹앱으로 배포(자세한 절차는 파일 상단 주석).

Vercel 환경변수:
| 변수 | 값 |
|---|---|
| `GOOGLE_SHEET_WEBHOOK_URL` | Apps Script 배포 URL(.../exec) |
| `GOOGLE_SHEET_TOKEN` | Apps Script `SECRET_TOKEN` 과 동일한 임의 문자열 |

- 시트 헤더 권장: `일시 | 성함 | 휴대폰 | 이메일 | 유입경로`
- 다른 단계(예: 4차 신청)도 `source` 값만 바꿔 같은 시트/함수로 확장 가능.

### 통합 시트 관리 (리드 + 2단계 시청추적)
모든 이벤트를 **첫 번째 시트 한 곳**에 이어붙입니다.
컬럼: `일시 | 이벤트 | 성함 | 휴대폰 | 이메일 | 유입경로`
- 1단계 신청 → 이벤트 `신청`(유입경로 optin-1)
- 2단계 시청추적 → 이벤트 `재생`/`도달`(85%)/`클릭`, 이벤트별 1회 기록
- 이벤트: `재생`(재생 시작) · `도달`(영상 85% 시청) · `클릭`(CTA 클릭)
- 방문자 식별: 1단계 제출 시 `localStorage.scLead`에 저장한 성함·휴대폰·이메일 사용
  (같은 브라우저에서 1→2단계로 이어질 때. 문자링크로 다른 기기 진입 시엔 식별값이 비어 익명 기록)
- 추가 환경변수 불필요(save-lead의 `GOOGLE_SHEET_WEBHOOK_URL`·`GOOGLE_SHEET_TOKEN` 재사용).
- ⚠️ Code.gs를 갱신했으므로 Apps Script를 **"새 버전"으로 재배포**해야 시청추적 탭이 동작합니다.

## 2차 문자 자동 회수 (이탈자 리마케팅)
`apps-script/Remind.gs` 를 구글시트 Apps Script에 **새 파일로 추가**하면, 이벤트 로그(시트1)를
사람(휴대폰)별로 집계해 3그룹으로 분류하고 그룹별 2차 문자를 Solapi로 발송합니다.
- 미시청(신청O·재생X) → /watch 재안내 · 중도이탈(재생O·도달X) → /watch 이어보기 · 도달·미신청(도달O·클릭X) → /consult 유도
- 결과는 `대상관리` 탭에 사람별 상태·발송이력으로 정리(중복발송 방지)
- 크리덴셜은 Apps Script **스크립트 속성**(SOLAPI_KEY/SECRET/SENDER)에 저장(코드 미노출)
- 상단 메뉴 "2차문자 자동화"로 수동 실행, 또는 dailyRun()을 시간 트리거에 연결해 자동화

## 로컬 미리보기
```bash
python3 -m http.server 8080
# http://localhost:8080 접속
```

## 배포 (Vercel)
GitHub 레포를 Vercel에 Import 하면 **빌드 설정 없이(Other/정적)** 자동 배포됩니다.
`main` 브랜치에 push 할 때마다 자동 재배포됩니다.
