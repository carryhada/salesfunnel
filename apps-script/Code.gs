/**
 * 구글시트 자동화 — Apps Script 웹앱
 *   · 리드(1단계 신청)   → 첫 번째 시트 [일시·성함·휴대폰·이메일·유입경로]
 *   · 시청추적(2단계)     → "시청추적" 시트 [일시·이벤트·성함·휴대폰·이메일]  (자동 생성)
 *
 * [설치]
 * 1) 구글시트 → 확장 프로그램 → Apps Script → 이 코드 전체 붙여넣기
 * 2) SECRET_TOKEN 을 임의 문자열로 바꾸고, Vercel GOOGLE_SHEET_TOKEN 과 동일하게 맞추기
 * 3) 배포 → (기존이 있으면) 배포 관리 → 편집 → "새 버전" 으로 재배포
 *      - 실행: 나 / 액세스: 모든 사용자(Anyone)
 *    ※ 코드를 바꾸면 반드시 "새 버전"으로 재배포해야 반영됩니다.
 */

var SECRET_TOKEN = 'CHANGE_ME_아무문자열로_바꾸세요';   // ← Vercel GOOGLE_SHEET_TOKEN 과 동일하게
var LEAD_SHEET_NAME  = '';         // 비우면 첫 번째 시트를 리드 시트로 사용
var TRACK_SHEET_NAME = '시청추적';  // 시청추적 탭 이름(없으면 자동 생성)

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || '{}');

    if (SECRET_TOKEN && data.token !== SECRET_TOKEN) {
      return _json({ ok: false, error: 'unauthorized' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();

    if (data.kind === 'track') {
      // 2단계 시청추적
      var ts = _getSheet(ss, TRACK_SHEET_NAME, ['일시', '이벤트', '성함', '휴대폰', '이메일']);
      ts.appendRow([_now(), data.event || '', data.name || '', "'" + (data.phone || ''), data.email || '']);
    } else {
      // 1단계 리드
      var ls = LEAD_SHEET_NAME ? ss.getSheetByName(LEAD_SHEET_NAME) : ss.getSheets()[0];
      ls.appendRow([_now(), data.name || '', "'" + (data.phone || ''), data.email || '', data.source || '']);
    }

    return _json({ ok: true });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

/* 시트가 없으면 만들고 헤더를 넣어 반환 */
function _getSheet(ss, name, headers) {
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); }
  return sh;
}

function _now() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
