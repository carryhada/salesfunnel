/**
 * 구글시트 자동화 — Apps Script 웹앱 (단일 시트 통합관리)
 *   모든 이벤트를 "첫 번째 시트"에 한 줄씩 이어붙입니다.
 *   컬럼: 일시 | 이벤트 | 성함 | 휴대폰 | 이메일 | 유입경로
 *     · 1단계 신청    → 이벤트="신청",  유입경로=optin-1 등
 *     · 2단계 시청추적 → 이벤트="재생"/"도달"/"클릭"
 *
 * [설치]
 * 1) 구글시트 → 확장 프로그램 → Apps Script → 이 코드 전체 붙여넣기
 * 2) SECRET_TOKEN 을 Vercel GOOGLE_SHEET_TOKEN 과 동일한 값으로 설정
 * 3) 배포 → 배포 관리 → ✏️편집 → 버전 "새 버전" → 배포
 *    ※ 코드를 바꾸면 반드시 "새 버전"으로 재배포해야 반영됩니다.
 *
 * [기존 시트 정리]  헤더가 새로 잡히도록, 최초 1회 시트1의 기존 내용을 비워주세요.
 *   (시청추적 탭을 따로 만들었다면 그 탭은 삭제해도 됩니다)
 */

var SECRET_TOKEN = 'CHANGE_ME_아무문자열로_바꾸세요';   // ← Vercel GOOGLE_SHEET_TOKEN 과 동일하게 (예: sc-xxxxxxxx)
var SHEET_NAME   = '';   // 비우면 첫 번째 시트 사용
var HEADERS = ['일시', '이벤트', '성함', '휴대폰', '이메일', '유입경로'];

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents || '{}');

    if (SECRET_TOKEN && data.token !== SECRET_TOKEN) {
      return _json({ ok: false, error: 'unauthorized' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];

    if (sh.getLastRow() === 0) sh.appendRow(HEADERS);   // 빈 시트면 헤더 자동 생성

    var isTrack = (data.kind === 'track');
    var event  = isTrack ? (data.event || '') : '신청';
    var source = isTrack ? '' : (data.source || '');

    sh.appendRow([
      _now(),
      event,
      data.name || '',
      "'" + (data.phone || ''),   // 앞 0 유지를 위해 문자열 처리
      data.email || '',
      source
    ]);

    return _json({ ok: true });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function _now() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
