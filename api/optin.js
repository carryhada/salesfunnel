// ============================================================================
//  POST /api/optin  — 1단계 옵트인 접수
//  · 12자리 토큰 발급 → Apps Script(action:optin)로 시트에 행 추가
//  · 토큰을 httpOnly 쿠키 + 응답 body 둘 다로 반환
//  · 프론트는 응답의 next(/watch?t=토큰)로 이동
//
//  Vercel 환경변수 (둘 중 아무 이름이나 인식 — 기존 값 그대로 써도 됨)
//    SHEETS_WEBHOOK_URL  또는  GOOGLE_SHEET_WEBHOOK_URL
//    SHEETS_SECRET       또는  GOOGLE_SHEET_TOKEN
// ============================================================================

const crypto = require('crypto');

const WEBHOOK = () => process.env.SHEETS_WEBHOOK_URL || process.env.GOOGLE_SHEET_WEBHOOK_URL || '';
const SECRET  = () => process.env.SHEETS_SECRET      || process.env.GOOGLE_SHEET_TOKEN       || '';

/* 12자리 토큰 (혼동 문자 제외) */
function makeToken() {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const buf = crypto.randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += CHARS[buf[i] % CHARS.length];
  return out;
}

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('82')) d = '0' + d.slice(2);
  if (d && d[0] !== '0') d = '0' + d;
  return d;
}

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

/* Apps Script 호출 (실패 시 1회 재시도).
   optin은 토큰 기준 UPSERT라 재시도해도 행이 중복되지 않음 */
async function postToSheets(payload) {
  const url = WEBHOOK();
  if (!url) return { ok: false, error: 'webhook_not_set' };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow'          // Apps Script는 302로 결과를 넘김
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch (e) { data = null; }
      if (r.ok && data && data.ok) return { ok: true, data };
      if (data && data.error) return { ok: false, error: data.error };   // Apps Script가 준 사유 그대로
      if (attempt === 1) {
        console.error('sheets 응답 이상:', r.status, text.slice(0, 300));
        return { ok: false, error: data ? 'sheets_bad_response' : 'sheets_non_json_' + r.status };
      }
    } catch (err) {
      if (attempt === 1) {
        console.error('sheets 호출 실패:', err);
        return { ok: false, error: 'sheets_fetch_failed' };
      }
    }
    await new Promise(res => setTimeout(res, 400));   // 재시도 전 짧은 대기
  }
  return { ok: false, error: 'unknown' };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method Not Allowed' }); return; }
  if (!isAllowedOrigin(req)) { res.status(403).json({ ok: false, error: 'Forbidden origin' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const name  = String(body.name || '').trim().slice(0, 40);
  const phone = normalizePhone(body.phone);
  const email = String(body.email || '').trim().slice(0, 100);
  const utm   = String(body.utm || '').trim().slice(0, 60);

  if (!name)  { res.status(400).json({ ok: false, error: '성함을 입력해 주세요.' }); return; }
  if (phone.length < 10 || phone.length > 11) { res.status(400).json({ ok: false, error: '휴대폰 번호를 확인해 주세요.' }); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { res.status(400).json({ ok: false, error: '이메일을 확인해 주세요.' }); return; }
  if (!SECRET()) { console.error('SHEETS_SECRET 미설정'); res.status(500).json({ ok: false, error: '서버 설정 누락' }); return; }

  const token = makeToken();

  const result = await postToSheets({
    action: 'optin',
    secret: SECRET(),
    token, name, phone, email, utm
  });

  // 토큰 쿠키 (30일) — 다른 페이지에서도 같은 사람으로 식별
  res.setHeader('Set-Cookie',
    `sc_t=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`);

  // 시트 기록이 실패해도 사용자 흐름은 막지 않는다 (로그만 남김)
  if (!result.ok) console.error('optin 시트 기록 실패:', result.error);

  res.status(200).json({
    ok: true,
    token,
    sheet: result.ok ? 'saved' : 'failed',
    next: `/watch?t=${encodeURIComponent(token)}`
  });
};
