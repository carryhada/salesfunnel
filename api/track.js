// ============================================================================
//  POST /api/track  — 시청/행동 이벤트 중계
//  입력 : { token, event, watchedSec, unlockReason, payMethod }
//         event = play | reach | click | apply
//  · Apps Script(action:track)로 전달, 실패 시 1회 재시도
//  · 실패해도 사용자 화면은 절대 막지 않는다 (항상 200 응답)
//  · sendBeacon(text/plain)으로 와도 파싱됨
//
//  Vercel 환경변수 (둘 중 아무 이름이나 인식)
//    SHEETS_WEBHOOK_URL  또는  GOOGLE_SHEET_WEBHOOK_URL
//    SHEETS_SECRET       또는  GOOGLE_SHEET_TOKEN
// ============================================================================

const WEBHOOK = () => process.env.SHEETS_WEBHOOK_URL || process.env.GOOGLE_SHEET_WEBHOOK_URL || '';
const SECRET  = () => process.env.SHEETS_SECRET      || process.env.GOOGLE_SHEET_TOKEN       || '';

const ALLOWED_EVENTS = ['play', 'reach', 'click', 'apply'];

function isAllowedOrigin(req) {
  const host = req.headers.host || '';
  const o = req.headers.origin || req.headers.referer || '';
  let oh = '';
  try { oh = o ? new URL(o).host : ''; } catch (e) {}
  if (!oh || oh === host) return true;
  const allow = (process.env.CONFIRM_SMS_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return allow.some(a => oh === a || oh.endsWith('.' + a));
}

/* 쿠키에서 토큰 꺼내기 (body에 token이 없을 때 대비) */
function tokenFromCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(/(?:^|;\s*)sc_t=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function postToSheets(payload) {
  const url = WEBHOOK();
  if (!url) return { ok: false, error: 'webhook_not_set' };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow'
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch (e) { data = null; }
      if (r.ok && data && data.ok) return { ok: true, data };
      if (attempt === 1) {
        console.error('track 응답 이상:', r.status, text.slice(0, 300));
        return { ok: false, error: (data && data.error) || 'sheets_bad_response' };
      }
    } catch (err) {
      if (attempt === 1) {
        console.error('track 호출 실패:', err);
        return { ok: false, error: 'sheets_fetch_failed' };
      }
    }
    await new Promise(res => setTimeout(res, 400));
  }
  return { ok: false, error: 'unknown' };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method Not Allowed' }); return; }
  if (!isAllowedOrigin(req)) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }

  // sendBeacon은 Content-Type이 text/plain → 문자열로 들어옴
  let body = req.body;
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const token = String(body.token || '').trim() || tokenFromCookie(req);
  const event = String(body.event || '').trim();

  // 검증 실패도 200으로 응답 (화면을 막지 않기 위해). 이유는 body에 담아 전달
  if (!token) { res.status(200).json({ ok: false, error: 'token_required' }); return; }
  if (ALLOWED_EVENTS.indexOf(event) === -1) { res.status(200).json({ ok: false, error: 'bad_event', event }); return; }
  if (!SECRET()) { console.error('SHEETS_SECRET 미설정'); res.status(200).json({ ok: false, error: 'server_config' }); return; }

  let watchedSec = Number(body.watchedSec);
  if (!isFinite(watchedSec) || watchedSec < 0) watchedSec = 0;

  const result = await postToSheets({
    action: 'track',
    secret: SECRET(),
    token,
    event,
    watchedSec: Math.round(watchedSec),
    unlockReason: String(body.unlockReason || '').slice(0, 40),
    payMethod: String(body.payMethod || '').slice(0, 20)
  });

  if (!result.ok) console.error('track 시트 기록 실패:', event, result.error);

  // 항상 200 — 프론트는 이 응답을 기다리지 않고 진행해도 됨
  res.status(200).json(result.ok
    ? { ok: true, stage: result.data.stage, watchedSec: result.data.watchedSec, paid: result.data.paid }
    : { ok: false, error: result.error });
};
