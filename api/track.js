// ============================================================
//  /api/track  —  2단계 영상 시청추적 → 구글시트 "시청추적" 탭
//  이벤트: 재생 / 도달(85%) / 클릭
//  save-lead 와 동일한 Apps Script 웹앱(GOOGLE_SHEET_WEBHOOK_URL)으로 보내되
//  kind:'track' 플래그로 Apps Script가 "시청추적" 시트에 기록하도록 합니다.
//
//  필요한 Vercel 환경변수 (이미 save-lead에서 사용 중 — 추가 설정 불필요):
//    GOOGLE_SHEET_WEBHOOK_URL, GOOGLE_SHEET_TOKEN
//    (선택) CONFIRM_SMS_ALLOWED_ORIGINS
// ============================================================

var ALLOWED_EVENTS = ['재생', '도달', '클릭'];

function normalizePhone(raw) {
  var d = String(raw || '').replace(/\D/g, '');
  if (d.indexOf('82') === 0) d = '0' + d.slice(2);
  if (d && d[0] !== '0') d = '0' + d;
  return d;
}

function isAllowedOrigin(req) {
  var host = req.headers.host || '';
  var originHeader = req.headers.origin || req.headers.referer || '';
  var originHost = '';
  try { originHost = originHeader ? new URL(originHeader).host : ''; } catch (e) {}
  if (!originHost) return true;
  if (originHost === host) return true;
  var allow = (process.env.CONFIRM_SMS_ALLOWED_ORIGINS || '')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return allow.some(function (a) { return originHost === a || originHost.slice(-(a.length + 1)) === '.' + a; });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method Not Allowed' }); return; }
  if (!isAllowedOrigin(req)) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }

  var body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  var event = String(body.event || '').trim();
  if (ALLOWED_EVENTS.indexOf(event) === -1) {
    res.status(400).json({ ok: false, error: '허용되지 않은 이벤트' });
    return;
  }

  var url = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!url) { console.error('GOOGLE_SHEET_WEBHOOK_URL 미설정'); res.status(500).json({ ok: false, error: '시트 설정 누락' }); return; }

  var payload = {
    kind: 'track',
    event: event,
    name: String(body.name || '').trim().slice(0, 40),
    phone: normalizePhone(body.phone),
    email: String(body.email || '').trim().slice(0, 100),
    token: process.env.GOOGLE_SHEET_TOKEN || ''
  };

  try {
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow'
    });
    var text = await r.text();
    var data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
    if (!r.ok || (data && data.ok === false)) {
      console.error('시청추적 저장 실패:', r.status, text);
      res.status(502).json({ ok: false, error: '추적 저장 실패', detail: data });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('시청추적 호출 오류:', err);
    res.status(500).json({ ok: false, error: '추적 저장 중 오류' });
  }
};
