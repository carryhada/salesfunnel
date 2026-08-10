/**
 * 2차 문자 자동 회수 — 미시청 / 중도이탈 / 도달·미신청 분류 + Solapi 발송
 * (구글시트에 바인딩된 Apps Script 프로젝트에 "새 파일"로 추가하세요. 기존 Code.gs는 그대로 둡니다.)
 *
 * ── 준비(최초 1회) ──────────────────────────────────────────
 * 1) Apps Script → ⚙ 프로젝트 설정 → "스크립트 속성"에 3개 추가:
 *      SOLAPI_KEY     = 솔라피 API Key
 *      SOLAPI_SECRET  = 솔라피 API Secret
 *      SOLAPI_SENDER  = 사전등록 발신번호(예: 01012345678)
 *    (Vercel에 넣은 값과 동일. 코드에 직접 넣지 않아 안전)
 * 2) 저장 후 시트를 새로고침하면 상단에 "2차문자 자동화" 메뉴가 생깁니다.
 * 3) 테스트: 아래 TEST_ONLY_PHONE 에 본인 번호를 넣으면 그 번호로만 발송됩니다.
 *    (검증 끝나면 '' 로 비워 전체 발송)
 * ───────────────────────────────────────────────────────────
 */

var SITE            = 'https://njob.vercel.app';  // 링크 도메인
var LOG_SHEET       = '';        // 이벤트 로그 시트 (비우면 첫 번째 시트=시트1)
var AUDIENCE_SHEET  = '대상관리'; // 분류 결과 탭 (자동 생성)
var TEST_ONLY_PHONE = '';        // 테스트: 이 번호로만 발송 (예 '01012345678'). 실전은 ''

/* 상단 커스텀 메뉴 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('2차문자 자동화')
    .addItem('① 대상 분류 새로고침', 'buildAudience')
    .addItem('② 2차 문자 발송(미발송분)', 'send2ndSMS')
    .addSeparator()
    .addItem('①+② 한번에 실행', 'dailyRun')
    .addToUi();
}

/* 시간 트리거로 매일 자동 실행하려면 이 함수를 트리거에 연결 */
function dailyRun() { buildAudience(); send2ndSMS(); }

/* ① 이벤트 로그 → 사람(휴대폰)별 상태 분류 → 대상관리 탭 */
function buildAudience() {
  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var log = LOG_SHEET ? ss.getSheetByName(LOG_SHEET) : ss.getSheets()[0];
  var data = log.getDataRange().getValues();   // 헤더: 일시 이벤트 성함 휴대폰 이메일 유입경로

  var people = {};  // phone -> {name, email, events:{}}
  for (var i = 1; i < data.length; i++) {
    var event = String(data[i][1] || '').trim();
    var name  = String(data[i][2] || '').trim();
    var phone = String(data[i][3] || '').replace(/[^0-9]/g, '');
    var email = String(data[i][4] || '').trim();
    if (!phone) continue;
    if (!people[phone]) people[phone] = { name: name, email: email, events: {} };
    if (event) people[phone].events[event] = true;
    if (name)  people[phone].name  = name;
    if (email) people[phone].email = email;
  }

  function statusOf(ev) {
    if (ev['예약완료'] || ev['클릭']) return '전환(제외)';
    if (ev['도달']) return '도달·미신청';
    if (ev['재생']) return '중도이탈';
    if (ev['신청']) return '미시청';
    return '기타';
  }

  // 기존 대상관리의 발송이력 보존
  var aud = ss.getSheetByName(AUDIENCE_SHEET);
  var prevHist = {};
  if (aud) {
    var av = aud.getDataRange().getValues();
    for (var j = 1; j < av.length; j++) {
      var p = String(av[j][1] || '').replace(/[^0-9]/g, '');
      if (p) prevHist[p] = String(av[j][4] || '');
    }
    aud.clear();
  } else {
    aud = ss.insertSheet(AUDIENCE_SHEET);
  }

  var rows = [['성함', '휴대폰', '이메일', '상태', '발송이력', '최종발송일시']];
  var count = { '미시청': 0, '중도이탈': 0, '도달·미신청': 0, '전환(제외)': 0, '기타': 0 };
  Object.keys(people).forEach(function (phone) {
    var pp = people[phone];
    var st = statusOf(pp.events);
    count[st] = (count[st] || 0) + 1;
    rows.push([pp.name, "'" + phone, pp.email, st, prevHist[phone] || '', '']);
  });
  aud.getRange(1, 1, rows.length, 6).setValues(rows);

  ss.toast('분류 완료 · 미시청 ' + count['미시청'] + ' / 중도이탈 ' + count['중도이탈'] +
           ' / 도달·미신청 ' + count['도달·미신청'] + ' / 전환 ' + count['전환(제외)'], '2차문자 자동화', 8);
}

/* ② 상태별 2차 문자 발송 (발송이력에 없는 그룹만) */
function send2ndSMS() {
  var props  = PropertiesService.getScriptProperties();
  var KEY    = props.getProperty('SOLAPI_KEY');
  var SECRET = props.getProperty('SOLAPI_SECRET');
  var SENDER = String(props.getProperty('SOLAPI_SENDER') || '').replace(/[^0-9]/g, '');
  if (!KEY || !SECRET || !SENDER) {
    SpreadsheetApp.getActiveSpreadsheet().toast('스크립트 속성 SOLAPI_KEY/SECRET/SENDER 를 먼저 설정하세요.', '오류', 10);
    return;
  }

  var ss  = SpreadsheetApp.getActiveSpreadsheet();
  var aud = ss.getSheetByName(AUDIENCE_SHEET);
  if (!aud) { ss.toast('먼저 ① 대상 분류를 실행하세요.', '오류', 8); return; }

  var v = aud.getDataRange().getValues();
  var GROUP = { '미시청': 'A', '중도이탈': 'B', '도달·미신청': 'C' };
  var sent = 0, fail = 0, skip = 0;

  for (var i = 1; i < v.length; i++) {
    var name   = String(v[i][0] || '');
    var phone  = String(v[i][1] || '').replace(/[^0-9]/g, '');
    var status = String(v[i][3] || '');
    var hist   = String(v[i][4] || '');
    if (!phone) continue;

    var g = GROUP[status];
    if (!g) continue;                        // 전환/기타 제외
    if (hist.indexOf(g) >= 0) { skip++; continue; }   // 이미 그 그룹 발송함
    if (TEST_ONLY_PHONE && phone !== TEST_ONLY_PHONE.replace(/[^0-9]/g, '')) continue;

    var ok = sendSolapi_(KEY, SECRET, SENDER, phone, messageFor_(status, name));
    if (ok) {
      sent++;
      aud.getRange(i + 1, 5).setValue(hist ? hist + ',' + g : g);
      aud.getRange(i + 1, 6).setValue(now_());
    } else { fail++; }
    Utilities.sleep(120);
  }
  ss.toast('발송 완료 · 성공 ' + sent + ' / 실패 ' + fail + ' / 기발송 ' + skip, '2차문자 자동화', 10);
}

/* 상태별 문자 문구 */
function messageFor_(status, name) {
  var g = name ? name + '님, ' : '';
  if (status === '미시청')
    return '[캐리퀸] ' + g + '신청하신 무료특강 아직 안 보셨어요!\n' +
           '노트북 하나로 2개월 매출 1억 만든 구조, 지금 바로 확인하세요 ▶\n' + SITE + '/watch';
  if (status === '중도이탈')
    return '[캐리퀸] ' + g + '무료특강 초반만 보셨네요!\n' +
           '진짜 핵심(쿠팡보다 7배 효율·챗GPTs 1분 글쓰기)은 중반부에 있어요. 이어서 보기 ▶\n' + SITE + '/watch';
  if (status === '도달·미신청')
    return '[캐리퀸] ' + g + '특강 끝까지 보셨네요! 이제 나에게 맞는 수익화 설계를 받아보실 차례예요.\n' +
           '5만원 1:1 상담(프로젝트 등록 시 전액 차감) ▶\n' + SITE + '/consult';
  return '';
}

/* Solapi 단건 발송 (HMAC-SHA256) */
function sendSolapi_(key, secret, sender, to, text) {
  try {
    var date = new Date().toISOString();
    var salt = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    var raw  = Utilities.computeHmacSha256Signature(date + salt, secret);
    var sig  = raw.map(function (b) { b = (b < 0 ? b + 256 : b); var s = b.toString(16); return s.length === 1 ? '0' + s : s; }).join('');
    var isLMS = byteLen_(text) > 90;
    var msg = { to: to, from: sender, text: text, type: isLMS ? 'LMS' : 'SMS' };
    if (isLMS) msg.subject = '캐리퀸 안내';
    var res = UrlFetchApp.fetch('https://api.solapi.com/messages/v4/send', {
      method: 'post', contentType: 'application/json',
      headers: { Authorization: 'HMAC-SHA256 apiKey=' + key + ', date=' + date + ', salt=' + salt + ', signature=' + sig },
      payload: JSON.stringify({ message: msg }), muteHttpExceptions: true
    });
    var code = res.getResponseCode(), body = res.getContentText();
    if (code >= 200 && code < 300) { var d = JSON.parse(body); return d.statusCode === '2000' || !!d.messageId; }
    Logger.log('Solapi 실패 ' + code + ' ' + body); return false;
  } catch (e) { Logger.log('Solapi 오류 ' + e); return false; }
}

function byteLen_(s) { var n = 0; for (var i = 0; i < s.length; i++) n += s.charCodeAt(i) > 127 ? 2 : 1; return n; }
function now_() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'); }
