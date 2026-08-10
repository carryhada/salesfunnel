// ============================================================
//  /api/save-lead  —  구글시트 자동 리스트업 (Vercel 서버리스 함수)
//  1단계 옵트인 폼 제출 시 클라이언트가 호출합니다.
//  구글 Apps Script 웹앱(doPost)으로 전달 → 시트에 한 줄 추가.
//  웹앱 URL·토큰은 서버 환경변수에만 존재하며 브라우저에 노출되지 않습니다.
//
//  필요한 Vercel 환경변수 (Project Settings → Environment Variables):
//    GOOGLE_SHEET_WEBHOOK_URL : Apps Script 배포 URL(.../exec)
//    GOOGLE_SHEET_TOKEN       : Apps Script와 맞춰둔 비밀토큰(임의 문자열)
//    (선택) CONFIRM_SMS_ALLOWED_ORIGINS : 허용 도메인 콤마구분 (미설정 시 동일출처만 허용)
// ============================================================

function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('82')) d = '0' + d.slice(2);
  if (d && !d.startsWith('0')) d = '0' + d;
  return d;
}

function isAllowedOrigin(req) {
  const host = req.headers.host || '';
  const originHeader = req.headers.origin || req.headers.referer || '';
  let originHost = '';
  try { originHost = originHeader ? new URL(originHeader).host : ''; } catch (e) {}
  if (!originHost) return true;
  if (originHost === host) return true;
  const allow = (process.env.CONFIRM_SMS_ALLOWED_ORIGINS || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return allow.some(a => originHost === a || originHost.endsWith('.' + a));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
    return;
  }
  if (!isAllowedOrigin(req)) {
    res.status(403).json({ ok: false, error: 'Forbidden origin' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const lead = {
    tid: String(body.tid || '').trim().slice(0, 40),   // 리드 식별 토큰
    stage: '신청',
    name: String(body.name || '').trim().slice(0, 40),
    phone: normalizePhone(body.phone),
    email: String(body.email || '').trim().slice(0, 100),
    source: String(body.source || 'optin-1').trim().slice(0, 40),
    token: process.env.GOOGLE_SHEET_TOKEN || ''        // 인증용 시크릿
  };

  const url = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  if (!url) {
    console.error('GOOGLE_SHEET_WEBHOOK_URL 미설정');
    res.status(500).json({ ok: false, error: '시트 설정 누락(관리자 확인 필요)' });
    return;
  }

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
      redirect: 'follow'   // Apps Script는 302 리다이렉트로 응답 → 따라가야 함
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

    if (!r.ok || (data && data.ok === false)) {
      console.error('구글시트 저장 실패:', r.status, text);
      res.status(502).json({ ok: false, error: '시트 저장 실패', detail: data });
      return;
    }
    res.status(200).json({ ok: true, result: data });
  } catch (err) {
    console.error('구글시트 호출 오류:', err);
    res.status(500).json({ ok: false, error: '시트 저장 중 오류' });
  }
};
