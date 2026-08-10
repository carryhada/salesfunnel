// ============================================================
//  /api/confirm-sms  —  DirectSend 확인문자 자동발송 (Vercel 서버리스 함수)
//  1단계 옵트인 폼 제출 시 클라이언트가 호출합니다.
//  DirectSend API 키는 이 서버 함수 안(환경변수)에만 존재하며 브라우저에 노출되지 않습니다.
//
//  필요한 Vercel 환경변수 (Project Settings → Environment Variables):
//    DIRECTSEND_USERNAME  : 다이렉트센드 로그인 ID
//    DIRECTSEND_KEY       : 다이렉트센드 API Key
//    DIRECTSEND_SENDER    : 사전등록한 발신번호 (예: 01045114447)
//    (선택) CONFIRM_SMS_ALLOWED_ORIGINS : 허용 도메인 콤마구분 (미설정 시 동일출처만 허용)
// ============================================================

const DIRECTSEND_ENDPOINT = 'https://directsend.co.kr/index.php/api_v2/sms_change_word';

// 수신번호 정규화: 하이픈/공백 제거, 국가코드(+82) 제거, 0으로 시작하도록
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('82')) d = '0' + d.slice(2);        // +82 10... → 010...
  if (!d.startsWith('0')) d = '0' + d;                 // 안전장치
  return d;
}

// 간단한 출처 검증 (브라우저 교차출처 남용 차단)
function isAllowedOrigin(req) {
  const host = req.headers.host || '';
  const originHeader = req.headers.origin || req.headers.referer || '';
  let originHost = '';
  try { originHost = originHeader ? new URL(originHeader).host : ''; } catch (e) {}
  if (!originHost) return true;                        // 서버-서버/직접호출은 통과(브라우저가 아님)
  if (originHost === host) return true;                // 동일 출처 허용
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

  // 본문 파싱 (Vercel이 JSON을 자동 파싱하지만 안전하게 이중 처리)
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const name = String(body.name || '').trim().slice(0, 20);
  const phone = normalizePhone(body.phone);

  if (phone.length < 10 || phone.length > 11) {
    res.status(400).json({ ok: false, error: '유효하지 않은 휴대폰 번호' });
    return;
  }

  const { DIRECTSEND_USERNAME, DIRECTSEND_KEY, DIRECTSEND_SENDER } = process.env;
  if (!DIRECTSEND_USERNAME || !DIRECTSEND_KEY || !DIRECTSEND_SENDER) {
    console.error('DirectSend 환경변수 누락');
    res.status(500).json({ ok: false, error: 'SMS 설정 누락(관리자 확인 필요)' });
    return;
  }

  // 확인문자 내용 (URL 포함 → 자동으로 LMS로 발송됨)
  const watchUrl = `https://${req.headers.host}/watch`;
  const greet = name ? `${name}님, ` : '';
  const message =
    `[캐리퀸] ${greet}무료특강 신청이 완료되었습니다!\n` +
    `아래 링크에서 지금 바로 영상을 시청하세요 ▶\n` +
    `${watchUrl}\n\n` +
    `※ 본 메시지는 신청자에게 발송되는 안내입니다.`;

  const payload = {
    username: DIRECTSEND_USERNAME,
    key: DIRECTSEND_KEY,
    sender: DIRECTSEND_SENDER,
    receiver: [{ mobile: phone }],
    message: message
  };

  try {
    const dsRes = await fetch(DIRECTSEND_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'charset': 'utf-8',
        'cache-control': 'no-cache'
      },
      body: JSON.stringify(payload)
    });

    const text = await dsRes.text();
    let data; try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }

    // DirectSend는 정상 접수 시 status 0(성공) 계열을 반환
    const statusVal = data && (data.status !== undefined ? data.status : null);
    const okStatus = statusVal === 0 || statusVal === '0' || statusVal === 1 || statusVal === '1';

    if (!dsRes.ok || (statusVal !== null && !okStatus)) {
      console.error('DirectSend 발송 실패:', dsRes.status, text);
      res.status(502).json({ ok: false, error: 'SMS 발송 실패', detail: data });
      return;
    }

    res.status(200).json({ ok: true, result: data });
  } catch (err) {
    console.error('DirectSend 호출 오류:', err);
    res.status(500).json({ ok: false, error: 'SMS 발송 중 오류' });
  }
};
