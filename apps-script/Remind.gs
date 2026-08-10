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

/* 영상에서 '핵심'이 나오는 지점. 영상을 새로 찍어 바꾸면 이 값만 수정하면 문구 전체에 반영됨
   (예: 15분 영상이면 '11분') */
var KEY_POINT = '7분';

/* ── 메뉴 ────────────────────────────────────────────────────────────── */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('2차문자')
    .addItem('⓪ 연결·잔액 확인', 'checkSolapi')
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

/**
 * ⓪ 연결·잔액 확인 (권한 승인용으로도 사용)
 *  · Apps Script 편집기에서 이 함수를 ▶실행하면 외부요청 권한 승인창이 뜹니다.
 *    (문자 발송에 필요한 권한 — 한 번만 허용하면 이후 메뉴가 정상 동작)
 *  · 승인 후에는 솔라피 API 연결 상태와 남은 잔액을 알려줍니다.
 */
function checkSolapi() {
  var cfg = _solapi(); if (!cfg) return;
  var out;
  try {
    var date = new Date().toISOString();
    var salt = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    var sig = Utilities.computeHmacSha256Signature(date + salt, cfg.secret)
      .map(function (b) { b = (b < 0 ? b + 256 : b); var s = b.toString(16); return s.length === 1 ? '0' + s : s; })
      .join('');
    var res = UrlFetchApp.fetch('https://api.solapi.com/cash/v1/balance', {
      method: 'get',
      headers: { Authorization: 'HMAC-SHA256 apiKey=' + cfg.key + ', date=' + date + ', salt=' + salt + ', signature=' + sig },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode(), body = res.getContentText();
    Logger.log('balance ' + code + ' ' + body);
    var d = null; try { d = JSON.parse(body); } catch (e) {}
    if (code >= 200 && code < 300 && d) {
      out = '✅ 솔라피 연결 정상\n\n' +
            '잔액: ' + (d.balance != null ? Number(d.balance).toLocaleString() + '원' : '-') + '\n' +
            '포인트: ' + (d.point != null ? Number(d.point).toLocaleString() : '-') + '\n' +
            '발신번호: ' + cfg.sender + '\n\n' +
            '이제 "② 테스트 발송"을 실행하세요.';
    } else {
      out = '❌ 솔라피 응답 오류 (HTTP ' + code + ')\n' + body.slice(0, 200);
    }
  } catch (e) {
    out = '❌ 오류\n' + String(e).slice(0, 300) +
          '\n\n※ 권한 오류라면: Apps Script 편집기에서 함수 checkSolapi 를 ▶실행 → 권한 허용';
  }
  Logger.log(out);
  try { SpreadsheetApp.getUi().alert('솔라피 연결 확인', out, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { /* 편집기에서 실행한 경우 UI가 없으므로 로그로만 확인 */ }
}

/* ── ① 미리보기 ─────────────────────────────────────────────────────── */
function previewTargets() {
  var t = _collect();
  var msg = 'A 미시청 ' + t.A.length + '명 / B 중도이탈 ' + t.B.length + '명 / C 도달·미신청 ' + t.C.length + '명'
          + '\n(제외: 전환자 ' + t.skipConverted + ', 이미발송 ' + t.skipSent + ', ' + MIN_HOURS + '시간 미경과 ' + t.skipFresh + ')';
  SpreadsheetApp.getUi().alert('발송 대상 미리보기', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

/* ── ② 테스트 발송 ──────────────────────────────────────────────────── */
function sendTestOnly() {
  var cfg = _solapi(); if (!cfg) return;
  // TEST_PHONE 이 비어 있으면 발신번호(SOLAPI_SENDER)로 보냄 — 본인 번호라 테스트에 안전
  var to = _phone(TEST_PHONE) || cfg.sender;
  if (!to) { _toast('Remind.gs 상단 TEST_PHONE에 본인 번호를 넣어주세요.'); return; }

  var lines = [];
  ['A','B','C'].forEach(function (g) {
    var r = _send(cfg, to, _message(g, '테스트'));
    lines.push(g + ' : ' + (r.ok ? '성공' : '실패 → ' + r.info));
    Utilities.sleep(200);
  });
  SpreadsheetApp.getUi().alert(
    '테스트 발송 결과',
    '수신번호 ' + to + '\n발신번호 ' + cfg.sender + '\n\n' + lines.join('\n') +
    '\n\n※ 모두 성공인데 문자가 안 오면 솔라피 콘솔 > 발송내역에서 상태를 확인하세요.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
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
    var r = _send(cfg, t.phone, _message(group, t.name));
    if (r.ok) {
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

  /* A · 미시청 — 후킹(핵심 지점 제시) + 베네핏(0원·30분·1억) + 문제해결(재고/글쓰기) + 마감
     ⚠️ 마지막 줄의 '마감' 문구는 실제로 링크를 닫을 때만 쓰세요.
        지키지 않으면 다음 문자부터 신뢰가 떨어집니다. 안 닫을 거면 아래 SOFT 버전 사용. */
  if (group === 'A')
    return '[캐리퀸] ' + g + '신청하신 미공개 영상, 아직 안 보셨어요.\n\n' +
           '진짜 중요한 건 ' + KEY_POINT + ' 지점에 나옵니다.\n' +
           '투자금 0원 · 하루 30분 딸깍으로\n' +
           '2개월 매출 1억을 만든 그 구조요.\n\n' +
           '사입도, 재고도, 배송도, CS도 없습니다.\n' +
           '글쓰기 자신 없어도 챗GPTs가 1분이면 대신 씁니다.\n\n' +
           '미공개 영상이라 오픈 기간이 끝나면 닫힙니다.\n' +
           '오늘 안에 꼭 확인하세요 ▶\n' +
           SITE + '/watch';

  /* B · 중도이탈 — "후반부만이라도" + 핵심 숫자 미끼
     (앞부분에 없던 구체적 숫자를 흘려 재시청 유도) */
  if (group === 'B')
    return '[캐리퀸] ' + g + '영상 앞부분만 보고 나가셨네요.\n\n' +
           '아쉽게도 진짜 돈 되는 얘기는\n' +
           KEY_POINT + ' 지점부터 나옵니다.\n\n' +
           '· 쿠팡 3% 고정 vs 쇼핑커넥트 최대 40%\n' +
           '· 키워드+링크만 넣으면 글 1분 완성\n' +
           '· 팔로워 0명인데 7일 만에 첫 수익 낸 이유\n\n' +
           '거기까지만이라도 보고 판단하세요 ▶\n' + SITE + '/watch';

  /* C · 도달·미신청 — "가서 뭘 하는지" 구체화 → consult 링크
     (가장 뜨거운 층. 상담에서 받는 것을 명확히 제시) */
  return '[캐리퀸] ' + g + '영상 끝까지 보셨네요 👏\n\n' +
         '구조는 이해하셨을 겁니다.\n' +
         '문제는 "그래서 나는 뭘 팔지?"죠.\n\n' +
         '1:1 상담 60분에서 이걸 정해드립니다.\n' +
         '① 지금 수익을 막고 있는 병목 진단\n' +
         '② 나에게 맞는 상품군·황금키워드\n' +
         '③ 90일 실행 로드맵\n\n' +
         '혼자 1년 헤맬 걸 60분에 끝냅니다.\n' +
         '참가비 5만원 (등록 시 전액 차감)\n' +
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

/* 발송. 성공 여부와 함께 실패 사유를 그대로 돌려준다(진단용) */
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
    Logger.log('Solapi ' + code + ' ' + body);

    var d = null; try { d = JSON.parse(body); } catch (e) {}
    if (code >= 200 && code < 300 && d) {
      // 접수는 됐지만 개별 실패(잔액/발신번호 등)인 경우 statusMessage에 사유가 담김
      var ok = (d.statusCode === '2000') || (d.groupId && !d.errorCode);
      if (ok) return { ok: true, info: 'sent' };
      return { ok: false, info: (d.statusCode || d.errorCode || '') + ' ' + (d.statusMessage || d.errorMessage || body.slice(0, 120)) };
    }
    return { ok: false, info: 'HTTP ' + code + ' ' + (d ? (d.errorCode + ' ' + d.errorMessage) : body.slice(0, 120)) };
  } catch (e) {
    Logger.log('Solapi 오류 ' + e);
    return { ok: false, info: String(e).slice(0, 120) };
  }
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
