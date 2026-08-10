/**
 * 구글시트 수신 웹앱 — 토큰 기반 1인 1행 관리
 *   컬럼: 시각 | 이름 | 전화 | 이메일 | 상태 | 토큰 | 단계 | 단계시각 | 해제사유 | 시청초
 *   · 신청 시 발급한 '토큰'으로 같은 사람을 찾아 행을 업데이트(단계 진행/해제사유/시청초).
 *   · 상태(E)는 비워둠 — 2차문자 분류/발송용으로 추후 사용.
 *
 * [설치] 확장 프로그램 → Apps Script → 이 코드로 교체 →
 *        SECRET_TOKEN 을 Vercel GOOGLE_SHEET_TOKEN 과 동일하게 설정 →
 *        배포 → 배포 관리 → ✏️편집 → "새 버전" → 배포
 * [정리] 최초 1회 시트1의 기존 내용을 비워야 새 헤더가 잡힙니다.(시청추적 탭은 삭제)
 */

var SECRET_TOKEN = 'CHANGE_ME_아무문자열로_바꾸세요';   // ← Vercel GOOGLE_SHEET_TOKEN 과 동일
var SHEET_NAME   = '';   // 비우면 첫 번째 시트
var HEADERS = ['시각', '이름', '전화', '이메일', '상태', '토큰', '단계', '단계시각', '해제사유', '시청초'];

// 단계 진행 순서(뒤로 후퇴 방지용)
var STAGE_ORDER = { '신청': 1, '재생': 2, '도달': 3, '클릭': 4, '예약완료': 5 };

function doPost(e) {
  try {
    var d = JSON.parse(e.postData.contents || '{}');
    if (SECRET_TOKEN && d.token !== SECRET_TOKEN) {   // d.token = 인증용 시크릿
      return _json({ ok: false, error: 'unauthorized' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
    if (sh.getLastRow() === 0) sh.appendRow(HEADERS);

    var tid    = String(d.tid || '').trim();          // 리드 식별 토큰
    var stage  = String(d.stage || '').trim();        // 단계
    var reason = (d.reason != null) ? String(d.reason) : '';
    var watch  = (d.watchSec != null && d.watchSec !== '') ? d.watchSec : '';
    var now    = _now();

    // 토큰(F열=6)으로 기존 행 찾기
    var rowIdx = -1;
    if (tid) {
      var last = sh.getLastRow();
      if (last >= 2) {
        var col = sh.getRange(2, 6, last - 1, 1).getValues();
        for (var i = 0; i < col.length; i++) {
          if (String(col[i][0]) === tid) { rowIdx = i + 2; break; }
        }
      }
    }

    if (rowIdx > 0) {
      // 업데이트 — 단계는 앞으로만 진행
      if (stage) {
        var cur = String(sh.getRange(rowIdx, 7).getValue() || '');
        if ((STAGE_ORDER[stage] || 0) >= (STAGE_ORDER[cur] || 0)) {
          sh.getRange(rowIdx, 7).setValue(stage);
          sh.getRange(rowIdx, 8).setValue(now);
        }
      }
      if (reason) sh.getRange(rowIdx, 9).setValue(reason);
      if (watch !== '') sh.getRange(rowIdx, 10).setValue(watch);
      _fillIfEmpty(sh, rowIdx, 2, d.name);
      _fillIfEmpty(sh, rowIdx, 3, d.phone ? ("'" + String(d.phone)) : '');
      _fillIfEmpty(sh, rowIdx, 4, d.email);
    } else {
      // 신규 행
      sh.appendRow([
        now, d.name || '', d.phone ? ("'" + d.phone) : '', d.email || '',
        '', tid, stage, now, reason, watch
      ]);
    }
    return _json({ ok: true });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}

function _fillIfEmpty(sh, r, c, val) {
  if (!val) return;
  var cur = sh.getRange(r, c).getValue();
  if (cur === '' || cur === null) sh.getRange(r, c).setValue(val);
}
function _now() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'); }
function _json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
