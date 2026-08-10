/**
 * 구글시트 리드 자동 리스트업 — Apps Script 웹앱
 *
 * [설치]
 * 1) 구글시트 새로 만들기 → 1행에 헤더 입력: 일시 | 성함 | 휴대폰 | 이메일 | 유입경로
 * 2) 확장 프로그램 → Apps Script → 이 코드 전체 붙여넣기
 * 3) 아래 SECRET_TOKEN 값을 임의의 문자열로 바꾸고, 같은 값을 Vercel 환경변수
 *    GOOGLE_SHEET_TOKEN 에도 넣기 (양쪽이 같아야 함)
 * 4) 배포 → 새 배포 → 유형: 웹앱
 *      - 실행: 나(본인 계정)
 *      - 액세스 권한: 모든 사용자(Anyone)
 *    → 생성된 웹앱 URL(.../exec)을 복사해 Vercel 환경변수 GOOGLE_SHEET_WEBHOOK_URL 에 넣기
 * 5) (코드 수정 시) 반드시 "배포 관리 → 편집 → 새 버전"으로 재배포해야 반영됨
 */

var SECRET_TOKEN = 'CHANGE_ME_아무문자열로_바꾸세요';   // ← Vercel GOOGLE_SHEET_TOKEN 과 동일하게
var SHEET_NAME   = '';   // 비워두면 첫 번째 시트 사용. 특정 시트명 쓰려면 여기 입력.

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || '{}');

    // 비밀토큰 검증 (아무나 시트에 쓰는 것 방지)
    if (SECRET_TOKEN && data.token !== SECRET_TOKEN) {
      return _json({ ok: false, error: 'unauthorized' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];

    var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([
      now,
      data.name || '',
      "'" + (data.phone || ''),   // 앞 0 유지 위해 문자열 처리
      data.email || '',
      data.source || ''
    ]);

    return _json({ ok: true });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
