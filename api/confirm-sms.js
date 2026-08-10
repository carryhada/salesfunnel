// ============================================================
//  /api/confirm-sms  —  확인문자 자동발송 (Vercel 서버리스 함수 · 솔라피 Solapi)
//  1단계 옵트인 폼 제출 시 클라이언트가 호출합니다.
//  Solapi는 API키+시크릿(HMAC-SHA256) 인증만 쓰고 IP 등록이 필요 없어
//  Vercel(유동 IP)에서 바로 동작합니다. 키/시크릿은 서버 환경변수에만 존재.
//
//  필요한 Vercel 환경변수 (Project Settings → Environment Variables):
//    SOLAPI_API_KEY     : 솔라피 API Key
//    SOLAPI_API_SECRET  : 솔라피 API Secret
//    SOLAPI_SENDER      : 사전등록한 발신번호 (예: 01045114447)
//    (선택) CONFIRM_SMS_ALLOWED_ORIGINS : 허용 도메인 콤마구분 (미설정 시 동일출처만 허용)
// ============================================================

const crypto = require('crypto');
const SOLAPI_ENDPOINT = 'https://api.solapi.com/messages/v4/send';

// 수신/발신번호 정규화: 하이픈·공백 제거, 국가코드(+82) 제거, 0으로 시작
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('82')) d = '0' + d.slice(2);
  if (d && !d.startsWith('0')) d = '0' + d;
  return d;
}

// 대략적 바이트 수(한글 2, 그 외 1) → SMS/LMS 자동 판별
function byteLen(s) {
  let n = 0;
  for (const ch of String(s)) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}

// 솔라피 HMAC-SHA256 Authorization 헤더 생성
function buildAuthHeader(apiKey, apiSecret) {
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(32).toString('hex');
  const signature = crypto.createHmac('sha256', apiSecret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

// 브라우저 교차출처 남용 차단(비브라우저 직접호출은 통과 — 솔라피 잔액/한도로 백업 방어)
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

  const name = String(body.name || '').trim().slice(0, 20);
  const phone = normalizePhone(body.phone);
  if (phone.length < 10 || phone.length > 11) {
    res.status(400).json({ ok: false, error: '유효하지 않은 휴대폰 번호' });
    return;
  }

  const { SOLAPI_API_KEY, SOLAPI_API_SECRET, SOLAPI_SENDER } = process.env;
  if (!SOLAPI_API_KEY || !SOLAPI_API_SECRET || !SOLAPI_SENDER) {
    console.error('Solapi 환경변수 누락');
    res.status(500).json({ ok: false, error: 'SMS 설정 누락(관리자 확인 필요)' });
    return;
  }

  // 확인문자 내용 — type: 'optin'(무료특강 신청, 기본) / 'booking'(상담 예약 접수)
  const type = String(body.type || 'optin');
  const watchUrl = `https://${req.headers.host}/watch`;
  const greet = name ? `${name}님, ` : '';
  const text = type === 'booking'
    ? `[캐리퀸] ${greet}1:1 상담 예약·접수가 완료되었습니다!\n` +
      `예약하신 시간에 만나뵙겠습니다. 준비사항은 순차 안내드릴게요.\n` +
      `문의사항은 이 문자에 회신 주세요.`
    : `[캐리퀸] ${greet}무료특강 신청이 완료되었습니다!\n` +
      `아래 링크에서 지금 바로 영상을 시청하세요 ▶\n` +
      `${watchUrl}`;

  const message = {
    to: phone,
    from: normalizePhone(SOLAPI_SENDER),
    text: text,
    type: byteLen(text) > 90 ? 'LMS' : 'SMS'
  };
  if (message.type === 'LMS') message.subject = type === 'booking' ? '상담 예약 접수 완료' : '무료특강 신청 완료';

  try {
    const r = await fetch(SOLAPI_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': buildAuthHeader(SOLAPI_API_KEY, SOLAPI_API_SECRET),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ message })
    });
    const text2 = await r.text();
    let data; try { data = JSON.parse(text2); } catch (e) { data = { raw: text2 }; }

    // 성공: HTTP 2xx + statusCode '2000'(또는 messageId 존재)
    const statusCode = data && data.statusCode;
    const success = r.ok && (statusCode === '2000' || (data && data.messageId));
    if (!success) {
      console.error('Solapi 발송 실패:', r.status, text2);
      res.status(502).json({ ok: false, error: 'SMS 발송 실패', detail: data });
      return;
    }
    res.status(200).json({ ok: true, result: data });
  } catch (err) {
    console.error('Solapi 호출 오류:', err);
    res.status(500).json({ ok: false, error: 'SMS 발송 중 오류' });
  }
};
