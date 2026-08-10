/**
 * ============================================================================
 *  2차 문자 자동 회수 — 미시청(A) / 중도이탈(B) / 도달·미신청(C)
 *  (시트1의 토큰 스키마 기준. Code.gs와 같은 프로젝트에 "새 파일"로 추가)
 * ============================================================================
 *
 *  ── 설치 ──────────────────────────────────────────────────────────────
 *  1) Apps Script → 파일 + → 스크립트 → 이름 'Remind' → 이 코드 붙여넣기 → 저장
 *  2) 스크립트 속성에 이미 SOLAPI_KEY / SOLAPI_SECRET / SOLAPI_SENDER 가 있어야 함
 *  3) 시트를 새로고침하면 상단에 "2차문자" 메뉴가 생김
 *     ※ 이 파일은 웹앱과 무관하므로 재배포 필요 없음
 *
 *  ── 사용 순서 (안전) ──────────────────────────────────────────────────
 *  ① "대상 미리보기"로 몇 명인지 먼저 확인
 *  ② "테스트 발송(내 번호)"으로 문구 확인      ← TEST_PHONE 설정 필요
 *  ③ 문제 없으면 "A/B/C 발송" 또는 "전체 발송"
 *
 *  ── 안전장치 ─────────────────────────────────────────────────────────
 *  · 신청(전환)한 사람은 모든 그룹에서 제외
 *  · 옵트인 후 MIN_HOURS 지나야 발송 (방금 신청한 사람에게 바로 안 감)
 *  · 이미 체크박스가 켜졌거나 상태에 기록된 사람은 재발송 안 함
 *  · 1회 실행당 DAILY_CAP 건까지만 (실수로 대량 발송 방지)
 * ============================================================================
 */

var SITE       = 'https://njob.vercel.app';
var MIN_HOURS  = 6;      // 옵트인 후 최소 경과 시간(시간). 바로 문자 가는 것 방지
var DAILY_CAP  = 100;    // 1회 실행당 최대 발송 건수
var TEST_PHONE = '';     // 테스트 발송받을 번호 (예 '01051710081'). 비우면 테스트 메뉴 비활성

/* ── 메뉴 ────────────────────────────────────────────────────────────── */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('2차문자')
    .addItem('① 대상 미리보기', 'previewTargets')
    .addItem('② 테스트 발송(내 번호)', 'sendTestOnly')
    .addSeparator()
    .addItem('A · 미시청 발송', 'sendA')
    .addItem('B · 중도이탈 발송', 'sendB')
    .addItem('C · 도달·미신청 발송', 'sendC')
    .addSeparator()
    .addItem('전체 발송 (A+B+C)', 'sendAll')
    .addToUi();
}

function sendA(){ runSend('A'); }
function sendB(){ runSend('B'); }
function sendC(){ runSend('C'); }
function sendAll(){ ['A','B','C'].forEach(function(g){ runSend(g, true); }); _toast('전체 발송 완료'); }

/* ── ① 미리보기 ─────────────────────────────────────────────────────── */
function previewTargets() {
  var t = _collect();
  var msg = 'A 미시청 ' + t.A.length + '명 / B 중도이탈 ' + t.B.length + '명 / C 도달·미신청 ' + t.C.length + '명'
          + '\n(제외: 전환자 ' + t.skipConverted + ', 이미발송 ' + t.skipSent + ', ' + MIN_HOURS + '시간 미경과 ' + t.skipFresh + ')';
  SpreadsheetApp.getUi().alert('발송 대상 미리보기', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

/* ── ② 테스트 발송 ──────────────────────────────────────────────────── */
function sendTestOnly() {
  if (!TEST_PHONE) { _toast('Remind.gs 상단 TEST_PHONE에 본인 번호를 넣어주세요.'); return; }
  var cfg = _solapi(); if (!cfg) return;
  ['A','B','C'].forEach(function (g) {
    _send(cfg, _phone(TEST_PHONE), _message(g, '테스트'));
    Utilities.sleep(200);
  });
  _toast('테스트 문자 3건을 ' + TEST_PHONE + ' 로 보냈습니다.');
}

/* ── 실제 발송 ──────────────────────────────────────────────────────── */
function runSend(group, quiet) {
  var cfg = _solapi(); if (!cfg) return;
  var sh = _mainSheet(), map = _map(sh);
  var targets = _collect()[group];
  if (!targets.length) { if (!quiet) _toast(group + ' 그룹 대상이 없습니다.'); return; }

  var sent = 0, fail = 0;
  for (var i = 0; i < targets.length && sent < DAILY_CAP; i++) {
    var t = targets[i];
    if (_send(cfg, t.phone, _message(group, t.name))) {
      sent++;
      _stamp(sh, map, t.row, group);          // 체크박스 ON + 상태 기록
    } else fail++;
    Utilities.sleep(150);
  }
  if (!quiet) _toast(group + ' 발송 완료 · 성공 ' + sent + ' / 실패 ' + fail);
}

/* ── 대상 분류 ──────────────────────────────────────────────────────── */
function _collect() {
  var sh = _mainSheet(), map = _map(sh);
  var out = { A: [], B: [], C: [], skipConverted: 0, skipSent: 0, skipFresh: 0 };
  var last = sh.getLastRow();
  if (last < 2) return out;

  var lastCol = sh.getLastColumn();
  var rows = sh.getRange(2, 1, last - 1, lastCol).getValues();
  var now = new Date().getTime();

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i], rowNo = i + 2;
    var phone = _phone(_val(r, map.phone));
    if (phone.length < 10) continue;

    var stage   = String(_val(r, map.stage) || '');
    var watched = Number(_val(r, map.watchedSec)) || 0;
    var status  = String(_val(r, map.status) || '');
    var name    = String(_val(r, map.name) || '');

    if (stage === '신청') { out.skipConverted++; continue; }        // 전환자 제외

    var ts = _time(_val(r, map.ts));
    if (ts && (now - ts) < MIN_HOURS * 3600 * 1000) { out.skipFresh++; continue; }

    var group = '';
    if (stage === '옵트인' || watched < 30) group = 'A';            // 미시청
    else if (stage === '재생') group = 'B';                          // 중도이탈
    else if (stage === '도달' || stage === '클릭') group = 'C';      // 도달·미신청
    if (!group) continue;

    // 이미 보낸 사람 제외 (체크박스 또는 상태 기록)
    var boxKey = { A: 'smsA', B: 'smsB', C: 'smsC' }[group];
    var checked = map[boxKey] ? (_val(r, map[boxKey]) === true) : false;
    if (checked || status.indexOf(_label(group)) !== -1) { out.skipSent++; continue; }

    out[group].push({ row: rowNo, phone: phone, name: name });
  }
  return out;
}

/* ── 발송 표시 (체크박스 + 상태) ────────────────────────────────────── */
function _stamp(sh, map, row, group) {
  var key = { A: 'smsA', B: 'smsB', C: 'smsC' }[group];
  if (map[key]) {
    var cell = sh.getRange(row, map[key]);
    cell.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    cell.setValue(true);
  }
  if (map.status) {
    var cur = String(sh.getRange(row, map.status).getValue() || '');
    var tag = _label(group) + '@' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'MM-dd HH:mm');
    sh.getRange(row, map.status).setValue(cur ? cur + ', ' + tag : tag);
  }
}

/* ── 문자 문구 ──────────────────────────────────────────────────────── */
function _message(group, name) {
  var g = name ? name + '님, ' : '';

  /* A · 미시청 — "아직 안 보셨나요?" + 영상 링크 다시
     (짧다는 점을 강조해 진입 장벽을 낮춤) */
  if (group === 'A')
    return '[캐리퀸] ' + g + '신청하신 무료특강 아직 안 보셨어요!\n\n' +
           '딱 7분이면 끝납니다.\n' +
           '재고·배송 없이 링크만 공유해서 2개월 매출 1억 만든 구조,\n' +
           '오늘 안에 꼭 확인해보세요 ▶\n' +
           SITE + '/watch';

  /* B · 중도이탈 — "후반부만이라도" + 핵심 숫자 미끼
     (앞부분에 없던 구체적 숫자를 흘려 재시청 유도) */
  if (group === 'B')
    return '[캐리퀸] ' + g + '특강 앞부분만 보고 나가셨네요.\n\n' +
           '진짜 핵심은 후반부에 있어요.\n' +
           '· 쿠팡 3% 고정 vs 쇼핑커넥트 최대 40%\n' +
           '· 챗GPTs로 글 1분 완성 (글쓰기 실력 불필요)\n' +
           '· 40대 육아맘 7일 만에 첫 수익\n\n' +
           '이어서 보기 ▶\n' + SITE + '/watch';

  /* C · 도달·미신청 — "가서 뭘 하는지" 구체화 → consult 링크
     (가장 뜨거운 층. 상담에서 받는 것을 명확히 제시) */
  return '[캐리퀸] ' + g + '특강 끝까지 보셨네요! 👏\n\n' +
         '이제 \'내 상황\'에 맞출 차례입니다.\n' +
         '1:1 상담 60분에서 이걸 드려요.\n' +
         '① 지금 수익화를 막고 있는 병목 진단\n' +
         '② 나에게 맞는 상품군·황금키워드\n' +
         '③ 90일 실행 로드맵\n\n' +
         '참가비 5만원 (프로젝트 등록 시 전액 차감)\n' +
         '이번 달 선착순 5명 ▶\n' + SITE + '/consult';
}
function _label(g) { return { A: 'remind_optin_sent', B: 'remind_partial_sent', C: 'remind_ready_sent' }[g]; }

/* ── Solapi ─────────────────────────────────────────────────────────── */
function _solapi() {
  var p = PropertiesService.getScriptProperties();
  var cfg = { key: p.getProperty('SOLAPI_KEY'), secret: p.getProperty('SOLAPI_SECRET'),
              sender: _phone(p.getProperty('SOLAPI_SENDER')) };
  if (!cfg.key || !cfg.secret || !cfg.sender) { _toast('스크립트 속성 SOLAPI_KEY/SECRET/SENDER 를 확인하세요.'); return null; }
  return cfg;
}

function _send(cfg, to, text) {
  try {
    var date = new Date().toISOString();
    var salt = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    var sig = Utilities.computeHmacSha256Signature(date + salt, cfg.secret)
      .map(function (b) { b = (b < 0 ? b + 256 : b); var s = b.toString(16); return s.length === 1 ? '0' + s : s; })
      .join('');
    var isLMS = _bytes(text) > 90;
    var msg = { to: to, from: cfg.sender, text: text, type: isLMS ? 'LMS' : 'SMS' };
    if (isLMS) msg.subject = '캐리퀸 안내';
    var res = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/send', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'HMAC-SHA256 apiKey=' + cfg.key + ', date=' + date + ', salt=' + salt + ', signature=' + sig },
      payload: JSON.stringify({ message: msg }), muteHttpExceptions: true
    });
    var code = res.getResponseCode(), body = res.getContentText();
    if (code >= 200 && code < 300) { var d = JSON.parse(body); return d.statusCode === '2000' || !!d.messageId; }
    Logger.log('Solapi 실패 ' + code + ' ' + body);
    return false;
  } catch (e) { Logger.log('Solapi 오류 ' + e); return false; }
}

/* ── 유틸 ───────────────────────────────────────────────────────────── */
function _mainSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet(), all = ss.getSheets();
  for (var i = 0; i < all.length; i++) if (_map(all[i]).token) return all[i];
  return all[0];
}
function _map(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0], m = {};
  var A = { '시각':'ts','이름':'name','전화':'phone','이메일':'email','상태':'status','토큰':'token',
            '단계':'stage','시청초':'watchedSec',
            '문자a(미시청)':'smsA','문자b(중도이탈)':'smsB','문자c(도달미신청)':'smsC',
            '문자a':'smsA','문자b':'smsB','문자c':'smsC' };
  for (var i = 0; i < head.length; i++) {
    var k = String(head[i] || '').trim().toLowerCase();
    if (A[k]) m[A[k]] = i + 1;
  }
  return m;
}
function _val(rowArr, col) { return col ? rowArr[col - 1] : ''; }
function _time(v) { if (v instanceof Date) return v.getTime();
  var d = new Date(String(v).replace(/-/g, '/')); return isNaN(d.getTime()) ? 0 : d.getTime(); }
function _phone(raw) {
  var d = String(raw || '').replace(/[^0-9]/g, '');
  if (d.indexOf('82') === 0) d = '0' + d.slice(2);
  if (d && d.charAt(0) !== '0') d = '0' + d;
  return d;
}
function _bytes(s) { var n = 0; for (var i = 0; i < s.length; i++) n += s.charCodeAt(i) > 127 ? 2 : 1; return n; }
function _toast(m) { SpreadsheetApp.getActiveSpreadsheet().toast(m, '2차문자', 8); }
