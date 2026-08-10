// ============================================================================
//  /api/segments  — 2차 문자 발송 대상 조회 / 발송 표시
//
//   GET  /api/segments?type=A&key=<SEGMENTS_KEY>[&minHours=6]
//        → { ok, type, count, phones:[...], targets:[{token,name,phone}] }
//          A 미시청 · B 중도이탈 · C 도달·미신청
//          (전환자 / 이미 발송 / minHours 미경과 는 자동 제외)
//
//   POST /api/segments   { key, group:'A'|'B'|'C', tokens:[...] }
//        → 발송 완료 표시 (체크박스 ON + 상태 기록)
//
//  ⚠️ 이 API는 고객 개인정보(연락처)를 반환하므로 반드시 키가 필요합니다.
//     Vercel 환경변수 SEGMENTS_KEY 를 설정하세요. (미설정 시 항상 거부)
// ============================================================================

const WEBHOOK = () => process.env.SHEETS_WEBHOOK_URL || process.env.GOOGLE_SHEET_WEBHOOK_URL || '';
const SECRET  = () => process.env.SHEETS_SECRET      || process.env.GOOGLE_SHEET_TOKEN       || '';

async function callSheets(payload) {
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
      if (data) return data;
      if (attempt === 1) {
        console.error('segments 응답 이상:', r.status, text.slice(0, 200));
        return { ok: false, error: 'sheets_non_json_' + r.status };
      }
    } catch (err) {
      if (attempt === 1) { console.error('segments 호출 실패:', err); return { ok: false, error: 'sheets_fetch_failed' }; }
    }
    await new Promise(res => setTimeout(res, 400));
  }
  return { ok: false, error: 'unknown' };
}

module.exports = async function handler(req, res) {
  // 개인정보 보호: 전용 키 없이는 접근 불가
  const gate = process.env.SEGMENTS_KEY;
  const given = String(
    (req.query && req.query.key) ||
    (req.headers['x-segments-key'] || '') ||
    ((typeof req.body === 'object' && req.body && req.body.key) || '')
  );
  if (!gate) { res.status(500).json({ ok: false, error: 'SEGMENTS_KEY 미설정' }); return; }
  if (given !== gate) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  if (!SECRET()) { res.status(500).json({ ok: false, error: '서버 설정 누락' }); return; }

  // ── 조회 ──
  if (req.method === 'GET') {
    const type = String((req.query && req.query.type) || '').toUpperCase();
    if (!['A', 'B', 'C'].includes(type)) { res.status(400).json({ ok: false, error: 'type은 A/B/C 중 하나' }); return; }
    const minHours = Number((req.query && req.query.minHours) ?? 6);

    const data = await callSheets({ action: 'segments', secret: SECRET(), type, minHours });
    if (!data.ok) { res.status(502).json(data); return; }

    res.status(200).json({
      ok: true,
      type,
      count: data.count,
      phones: (data.targets || []).map(t => t.phone),
      targets: data.targets || [],
      skipped: data.skipped
    });
    return;
  }

  // ── 발송 표시 ──
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const group = String(body.group || '').toUpperCase();
    const tokens = Array.isArray(body.tokens) ? body.tokens.slice(0, 500) : [];
    if (!['A', 'B', 'C'].includes(group)) { res.status(400).json({ ok: false, error: 'group은 A/B/C 중 하나' }); return; }
    if (!tokens.length) { res.status(400).json({ ok: false, error: 'tokens 배열이 비어 있습니다' }); return; }

    let marked = 0; const failed = [];
    for (const token of tokens) {
      const r = await callSheets({ action: 'mark', secret: SECRET(), token: String(token), group });
      if (r && r.ok) marked++; else failed.push(String(token));
    }
    res.status(200).json({ ok: true, group, marked, failed });
    return;
  }

  res.status(405).json({ ok: false, error: 'Method Not Allowed' });
};
