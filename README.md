# 쇼핑커넥트 수익화 퍼널 (Shopping Connect Funnel)

네이버 쇼핑커넥트 수익화 4단계 세일즈 퍼널. **한 레포에서 정적(static) 다중 페이지**로 배포합니다.

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

## 확인문자 자동발송 (DirectSend)
1차 폼 제출 시 → 스티비 등록 + **확인문자(SMS/LMS) 자동발송**.
문자는 브라우저에서 직접 못 보내므로(키 노출·요금 위험) **서버리스 함수 `api/confirm-sms.js`** 가 DirectSend를 호출합니다.

Vercel → Project → Settings → **Environment Variables** 에 등록:
| 변수 | 값 |
|---|---|
| `DIRECTSEND_USERNAME` | 다이렉트센드 로그인 ID |
| `DIRECTSEND_KEY` | 다이렉트센드 API Key |
| `DIRECTSEND_SENDER` | 사전등록한 발신번호(예: 01045114447) |
| `CONFIRM_SMS_ALLOWED_ORIGINS`(선택) | 커스텀 도메인 콤마구분 |

- 수신번호는 국가코드 없이 `0`으로 시작(자동 정규화됨).
- DirectSend "허용 IP"는 **비워두기**(Vercel IP 유동). 보안은 서버 보관 API키로 유지.
- 남용/요금폭탄 방지: DirectSend에서 **일일 발송/금액 한도**를 설정하세요.
- 문자 문구 수정: `api/confirm-sms.js`의 `message` 변수.

## 로컬 미리보기
```bash
python3 -m http.server 8080
# http://localhost:8080 접속
```

## 배포 (Vercel)
GitHub 레포를 Vercel에 Import 하면 **빌드 설정 없이(Other/정적)** 자동 배포됩니다.
`main` 브랜치에 push 할 때마다 자동 재배포됩니다.
