/**
 * ============================================================================
 *  자동화 퍼널 트래킹 — 구글시트 Web App (UPSERT)
 * ============================================================================
 *  절대 원칙 : 시트 1행 = 리드 1명.  토큰(F열)을 키로 UPSERT.
 *              같은 사람의 이벤트가 몇 번 들어와도 새 행을 만들지 않는다.
 *
 *  스키마(1행 헤더명으로 매핑. 열 위치가 바뀌어도 동작함)
 *    A 시각 | B 이름 | C 전화 | D 이메일 | E 상태 | F 토큰 | G 단계 | H 단계시각
 *    I 해제사유 | J 시청초 | K 재생시각 | L 도달시각 | M 클릭시각 | N utm/유입
 *
 *  단계 서열 : 옵트인(0) < 재생(1) < 도달(2) < 클릭(3) < 신청(4)
 *              들어온 등급이 현재보다 높을 때만 G/H 갱신 (역행 금지)
 *  시청초    : 항상 숫자. 기존값과 Math.max. 재생 안 했으면 0. 빈칸 금지.
 *  전화      : 항상 문자열(@ 서식) — 010 앞자리 0 보존
 *
 *  ── 설치 ────────────────────────────────────────────────────────────────
 *  1) 확장 프로그램 → Apps Script → 이 파일 내용으로 Code.gs 전면 교체
 *  2) ⚙ 프로젝트 설정 → 스크립트 속성에 추가:
 *        SHEETS_SECRET = (Vercel의 GOOGLE_SHEET_TOKEN 과 동일한 값)
 *  3) 배포 → "배포 관리" → ✏️연필 → 버전: **새 버전** → 배포
 *        · 실행: 나(소유자)   · 액세스 권한: 모든 사용자
 *        · 반드시 "새 배포"가 아니라 기존 배포의 "새 버전"으로 해야 URL이 유지됨
 *        · ⚠️ 코드를 고친 뒤 이 재배포를 하지 않으면 옛 코드가 계속 돈다 (가장 흔한 실패 원인)
 *  4) 실행 로그 확인: Apps Script 좌측 "실행" 탭 → 실패 행 클릭 → 로그 확인
 * ============================================================================
 */

var SHEET_NAME = '';   // 비우면 첫 번째 시트 사용

/* 헤더명 → 표준 키 (별칭 허용: 옛 시트/오타 대응) */
var HEADER_ALIASES = {
  '시각': 'ts', '최초시각': 'ts', '옵트인시각': 'ts', '일시': 'ts', '등록일시': 'ts',
  '이름': 'name', '성함': 'name',
  '전화': 'phone', '휴대폰': 'phone', '연락처': 'phone',
  '이메일': 'email',
  '상태': 'status',
  '토큰': 'token',
  '단계': 'stage',
  '단계시각': 'stageTs',
  '해제사유': 'reason',
  '시청초': 'watchedSec',
  '재생시각': 'playTs',
  '도달시각': 'reachTs',
  '클릭시각': 'clickTs',
  'utm/유입': 'utm', 'utm': 'utm', '유입': 'utm', '유입경로': 'utm',
  /* 2차 문자 발송 체크박스 (사람이 직접 켜고 끌 수 있음) */
  '문자a': 'smsA', '문자a(미시청)': 'smsA',
  '문자b': 'smsB', '문자b(중도이탈)': 'smsB',
  '문자c': 'smsC', '문자c(도달미신청)': 'smsC'
};

/* 결제(접수) 완료자만 따로 쌓는 탭 */
var PAID_SHEET_NAME = '결제완료';
var PAID_HEADERS = ['시각', '이름', '전화', '이메일', '토큰', '결제수단', '입금확인', '메모'];

/* 단계 서열 */
var STAGE_RANK = { '옵트인': 0, '재생': 1, '도달': 2, '클릭': 3, '신청': 4 };

/* event → 단계 */
var EVENT_TO_STAGE = { play: '재생', reach: '도달', click: '클릭', apply: '신청' };

/* ────────────────────────────────────────────────────────────────────────── */

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    // sendBeacon은 Content-Type이 text/plain으로 오므로 contents만 보고 파싱
    var raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    var body;
    try { body = JSON.parse(raw || '{}'); }
    catch (err) { return _json({ ok: false, error: 'bad_json' }); }

    // 인증 (secret 우선, 구버전 호환으로 token 필드도 허용)
    var expected = PropertiesService.getScriptProperties().getProperty('SHEETS_SECRET');
    var given = body.secret || body.authToken || '';
    if (!expected) return _json({ ok: false, error: 'server_secret_not_set' });
    if (given !== expected) return _json({ ok: false, error: 'unauthorized' });

    var action = String(body.action || '').trim();
    if (action !== 'optin' && action !== 'track' && action !== 'mark') {
      return _json({ ok: false, error: 'unknown_action', action: action });
    }

    if (!lock.tryLock(15000)) return _json({ ok: false, error: 'busy_lock_timeout' });

    var sh = _sheet();
    var map = _headerMap(sh);
    if (!map.token) return _json({ ok: false, error: 'header_token_not_found' });

    var token = String(body.token || '').trim();
    if (!token) return _json({ ok: false, error: 'token_required' });

    var row = _findRowByToken(sh, map.token, token);

    if (action === 'optin') {
      // 재시도로 같은 토큰이 다시 와도 새 행을 만들지 않는다 (1행=1리드 원칙)
      if (row > 0) {
        _updateOptinFields(sh, map, row, body);
        return _json({ ok: true, action: 'optin', mode: 'existing', row: row, token: token });
      }
      row = _appendOptin(sh, map, body, token);
      return _json({ ok: true, action: 'optin', mode: 'append', row: row, token: token });
    }

    // action === 'mark' : 2차 문자 발송 표시 (체크박스 ON + 상태 로그)
    if (action === 'mark') {
      if (row < 0) return _json({ ok: false, error: 'token_not_found', token: token });
      var group = String(body.group || '').toUpperCase();          // 'A' | 'B' | 'C'
      var key = { A: 'smsA', B: 'smsB', C: 'smsC' }[group];
      if (!key) return _json({ ok: false, error: 'bad_group', group: group });
      if (map[key]) {
        var cell = sh.getRange(row, map[key]);
        cell.setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
        cell.setValue(true);
      }
      if (map.status) {   // 감사 로그 (언제 무엇을 보냈는지 누적)
        var label = { A: 'remind_optin_sent', B: 'remind_partial_sent', C: 'remind_ready_sent' }[group];
        var cur = String(sh.getRange(row, map.status).getValue() || '');
        if (cur.indexOf(label) === -1) {
          sh.getRange(row, map.status).setValue(cur ? cur + ',' + label : label);
        }
      }
      return _json({ ok: true, action: 'mark', row: row, group: group });
    }

    // action === 'track'
    if (row < 0) {
      Logger.log('track: token_not_found ' + token);
      return _json({ ok: false, error: 'token_not_found', token: token });
    }
    var result = _applyTrack(sh, map, row, body);
    return _json({ ok: true, action: 'track', row: row, token: token,
                   stage: result.stage, watchedSec: result.watchedSec });

  } catch (err) {
    Logger.log('doPost error: ' + err);
    return _json({ ok: false, error: String(err) });
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

/**
 * GET = 헬스체크 / 진단
 *   그냥 열면      : 배포 확인
 *   ?debug=1 붙이면: 시트 탭 목록 + 각 탭의 1행 헤더 + 인식된 열 매핑
 *                    (어느 탭을 쓰는지, 헤더를 못 읽는지 바로 확인 가능)
 */
function doGet(e) {
  var debug = e && e.parameter && e.parameter.debug;
  if (!debug) return _json({ ok: true, service: 'funnel-tracker', ts: _now() });

  var ss = _ss();
  var target = _sheet();
  var tabs = ss.getSheets().map(function (sh) {
    var lastCol = Math.max(sh.getLastColumn(), 1);
    var head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (v) { return String(v || ''); });
    return { name: sh.getName(), rows: sh.getLastRow(), headers: head, mapped: _headerMap(sh) };
  });
  return _json({
    ok: true, ts: _now(),
    spreadsheet: ss.getName(),
    usingSheet: target ? target.getName() : null,
    secretSet: !!PropertiesService.getScriptProperties().getProperty('SHEETS_SECRET'),
    spreadsheetIdSet: !!PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID'),
    tabs: tabs
  });
}

/* ── 내부 ─────────────────────────────────────────────────────────────────── */

/**
 * 대상 시트 찾기
 *  1) SHEET_NAME이 지정돼 있으면 그 시트
 *  2) 아니면 1행에 "토큰" 헤더가 있는 시트를 자동 탐색 (탭 순서/이름 무관)
 *  3) 그래도 없으면 첫 번째 시트
 */
/**
 * 대상 스프레드시트
 *  스크립트 속성 SPREADSHEET_ID 가 있으면 그 파일을 열고(권장),
 *  없으면 이 스크립트가 붙어 있는 파일을 사용한다.
 *  ※ 다른 파일에 기록해야 할 때 SPREADSHEET_ID만 넣으면 됨 (배포 URL 유지)
 */
function _ss() {
  var id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id.trim()); }
    catch (e) { throw new Error('SPREADSHEET_ID로 시트를 열 수 없습니다: ' + e); }
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function _sheet() {
  var ss = _ss();
  if (SHEET_NAME) {
    var named = ss.getSheetByName(SHEET_NAME);
    if (named) return named;
  }
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    var m = _headerMap(all[i]);
    if (m.token) return all[i];
  }
  return all[0];
}

/** 1행 헤더명 → {key: columnIndex(1-based)} */
function _headerMap(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var map = {};
  for (var i = 0; i < head.length; i++) {
    var name = String(head[i] || '').trim().toLowerCase();
    if (!name) continue;
    for (var alias in HEADER_ALIASES) {
      if (alias.toLowerCase() === name) { map[HEADER_ALIASES[alias]] = i + 1; break; }
    }
  }
  return map;
}

/** F열(토큰) 전체를 한 번에 읽어 indexOf로 검색 → 행번호(1-based), 없으면 -1 */
function _findRowByToken(sh, tokenCol, token) {
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var col = sh.getRange(2, tokenCol, last - 1, 1).getValues();
  var flat = [];
  for (var i = 0; i < col.length; i++) flat.push(String(col[i][0]).trim());
  var idx = flat.indexOf(String(token).trim());
  return idx === -1 ? -1 : idx + 2;
}

/** 신규 옵트인 행 추가 */
function _appendOptin(sh, map, body, token) {
  var row = sh.getLastRow() + 1;
  var lastCol = Math.max(sh.getLastColumn(), _maxCol(map));

  // 전화 열은 문자열 서식 고정 (010 앞 0 보존)
  if (map.phone) sh.getRange(row, map.phone).setNumberFormat('@');

  var vals = new Array(lastCol);
  for (var i = 0; i < lastCol; i++) vals[i] = '';
  var now = _now();

  _put(vals, map.ts, now);
  _put(vals, map.name, String(body.name || ''));
  _put(vals, map.phone, _phone(body.phone));
  _put(vals, map.email, String(body.email || ''));
  _put(vals, map.status, '');                 // 문자 발송 이력 (빈칸에서 시작)
  _put(vals, map.token, token);
  _put(vals, map.stage, '옵트인');
  _put(vals, map.stageTs, now);
  _put(vals, map.reason, '');
  _put(vals, map.watchedSec, 0);              // 항상 숫자 0 (빈칸 금지)
  _put(vals, map.utm, String(body.utm || ''));

  sh.getRange(row, 1, 1, lastCol).setValues([vals]);
  _initCheckboxes(sh, map, row);   // 문자A/B/C 체크박스 생성(꺼진 상태)
  return row;
}

/** 문자 발송 체크박스 3개를 해당 행에 세팅 (없는 열은 건너뜀) */
function _initCheckboxes(sh, map, row) {
  var cb = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  ['smsA', 'smsB', 'smsC'].forEach(function (k) {
    if (!map[k]) return;
    var cell = sh.getRange(row, map[k]);
    cell.setDataValidation(cb);
    if (cell.getValue() === '') cell.setValue(false);
  });
}

/** 기존 행의 비어있는 인적사항만 보강 (덮어쓰기 방지) */
function _updateOptinFields(sh, map, row, body) {
  _fillIfEmpty(sh, row, map.name, String(body.name || ''));
  if (map.phone) {
    var cur = String(sh.getRange(row, map.phone).getValue() || '');
    if (!cur && body.phone) {
      sh.getRange(row, map.phone).setNumberFormat('@').setValue(_phone(body.phone));
    }
  }
  _fillIfEmpty(sh, row, map.email, String(body.email || ''));
  _fillIfEmpty(sh, row, map.utm, String(body.utm || ''));
}

/** track 이벤트 반영 : 단계 전진 + 시청초 max + 시각 스탬프 */
function _applyTrack(sh, map, row, body) {
  var now = _now();
  var event = String(body.event || '').trim();
  var incoming = EVENT_TO_STAGE[event] || '';

  // 1) 시청초 : 항상 숫자, 기존값과 비교해 더 큰 값
  var watched = null;
  if (map.watchedSec) {
    var curRaw = sh.getRange(row, map.watchedSec).getValue();
    var cur = Number(curRaw);
    if (!isFinite(cur) || cur < 0) cur = 0;
    var inc = Number(body.watchedSec);
    if (!isFinite(inc) || inc < 0) inc = 0;
    watched = Math.max(cur, Math.round(inc));
    sh.getRange(row, map.watchedSec).setValue(watched);
  }

  // 2) 단계 : 등급이 높을 때만 전진 (역행 금지)
  var finalStage = String(sh.getRange(row, map.stage).getValue() || '');
  if (incoming) {
    var curRank = (STAGE_RANK[finalStage] === undefined) ? -1 : STAGE_RANK[finalStage];
    var incRank = STAGE_RANK[incoming];
    if (incRank > curRank) {
      sh.getRange(row, map.stage).setValue(incoming);
      if (map.stageTs) sh.getRange(row, map.stageTs).setValue(now);
      finalStage = incoming;
    }
  }

  // 3) 이벤트별 최초 시각 스탬프 (이미 있으면 유지)
  if (event === 'play')  _fillIfEmpty(sh, row, map.playTs,  now);
  if (event === 'reach') _fillIfEmpty(sh, row, map.reachTs, now);
  if (event === 'click') _fillIfEmpty(sh, row, map.clickTs, now);

  // 4) 해제사유 : reach에서 전달된 값 기록 (timer(무재생)/timer/watch/cta)
  if (map.reason && body.unlockReason) {
    sh.getRange(row, map.reason).setValue(String(body.unlockReason));
  }

  // 5) 신청(접수완료) → '결제완료' 탭에 따로 적재
  var paid = false;
  if (event === 'apply') {
    paid = _upsertPaid(sh, map, row, body);
  }

  return { stage: finalStage, watchedSec: watched, paid: paid };
}

/**
 * '결제완료' 탭 upsert (토큰 기준, 중복 방지)
 *  ※ 실제 입금/결제 확인은 사람이 '입금확인' 체크박스로 처리
 */
function _upsertPaid(mainSh, map, row, body) {
  var ss = _ss();
  var ps = ss.getSheetByName(PAID_SHEET_NAME);
  if (!ps) {
    ps = ss.insertSheet(PAID_SHEET_NAME);
    ps.appendRow(PAID_HEADERS);
    ps.setFrozenRows(1);
  }
  if (ps.getLastRow() === 0) ps.appendRow(PAID_HEADERS);

  var token = String(mainSh.getRange(row, map.token).getValue() || '');
  // 토큰 열(E=5)에서 기존 행 찾기
  var last = ps.getLastRow();
  if (last >= 2) {
    var col = ps.getRange(2, 5, last - 1, 1).getValues();
    for (var i = 0; i < col.length; i++) {
      if (String(col[i][0]).trim() === token) return false;   // 이미 있음 → 중복 적재 안 함
    }
  }

  var r = ps.getLastRow() + 1;
  ps.getRange(r, 3).setNumberFormat('@');   // 전화 문자열 고정
  ps.getRange(r, 1, 1, PAID_HEADERS.length).setValues([[
    _now(),
    String(mainSh.getRange(row, map.name).getValue() || ''),
    String(mainSh.getRange(row, map.phone).getValue() || ''),
    String(mainSh.getRange(row, map.email).getValue() || ''),
    token,
    String(body.payMethod || ''),   // 카드 / 입금 (고객이 누른 버튼 기준)
    false,                          // 입금확인 체크박스 (사장님이 대조 후 직접 체크)
    ''
  ]]);
  ps.getRange(r, 7).setDataValidation(
    SpreadsheetApp.newDataValidation().requireCheckbox().build()
  );
  return true;
}

function _put(arr, col, val) { if (col) arr[col - 1] = val; }

function _fillIfEmpty(sh, row, col, val) {
  if (!col || val === '' || val === null || val === undefined) return;
  var cur = sh.getRange(row, col).getValue();
  if (cur === '' || cur === null) sh.getRange(row, col).setValue(val);
}

function _maxCol(map) {
  var m = 1;
  for (var k in map) if (map[k] > m) m = map[k];
  return m;
}

/** 숫자만 남기고 0으로 시작하게 정규화 (문자열 반환) */
function _phone(raw) {
  var d = String(raw || '').replace(/[^0-9]/g, '');
  if (d.indexOf('82') === 0) d = '0' + d.slice(2);
  if (d && d.charAt(0) !== '0') d = '0' + d;
  return d;
}

function _now() { return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'); }

function _json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
