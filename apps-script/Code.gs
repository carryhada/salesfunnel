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
  '시각': 'ts', '최초시각': 'ts', '옵트인시각': 'ts',
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
  'utm/유입': 'utm', 'utm': 'utm', '유입': 'utm', '유입경로': 'utm'
};

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
    if (action !== 'optin' && action !== 'track') {
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

/* GET은 헬스체크용 (브라우저로 열어 배포 확인) */
function doGet() {
  return _json({ ok: true, service: 'funnel-tracker', ts: _now() });
}

/* ── 내부 ─────────────────────────────────────────────────────────────────── */

function _sheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return SHEET_NAME ? ss.getSheetByName(SHEET_NAME) : ss.getSheets()[0];
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
  return row;
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

  return { stage: finalStage, watchedSec: watched };
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
