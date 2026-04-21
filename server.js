import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

// 한국도로공사 공공데이터 API (구간단속 카메라)
// 공식 키가 없으면 "test" 키로 호출 가능 (일일 호출량 제한 있음)
const EX_API_KEY = process.env.EX_API_KEY || 'test';
const EX_API_BASE = 'http://data.ex.co.kr/openapi/safetyDriving/safeSecCameraList';

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/section-cameras', async (req, res) => {
  try {
    const allRows = [];
    let pageNo = 1;
    const numOfRows = 100;

    while (true) {
      const url = `${EX_API_BASE}?key=${encodeURIComponent(EX_API_KEY)}&type=json&numOfRows=${numOfRows}&pageNo=${pageNo}`;
      const r = await fetch(url);
      if (!r.ok) {
        return res.status(502).json({ error: `upstream ${r.status}` });
      }
      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return res.status(502).json({ error: 'invalid upstream JSON', body: text.slice(0, 300) });
      }

      const list = data.list || data.items || [];
      allRows.push(...list);

      const total = Number(data.totalCount ?? data.count ?? list.length);
      if (allRows.length >= total || list.length === 0) break;
      pageNo += 1;
      if (pageNo > 50) break; // 안전장치
    }

    const normalized = allRows
      .map((row) => {
        // API 필드명이 환경에 따라 다를 수 있어 관대하게 매핑
        const startLng = Number(row.startGpsXcrd ?? row.startXCrd ?? row.startLng ?? row.xcdnt1);
        const startLat = Number(row.startGpsYcrd ?? row.startYCrd ?? row.startLat ?? row.ycdnt1);
        const endLng = Number(row.endGpsXcrd ?? row.endXCrd ?? row.endLng ?? row.xcdnt2);
        const endLat = Number(row.endGpsYcrd ?? row.endYCrd ?? row.endLat ?? row.ycdnt2);
        const rawDir = String(row.updownTypeCode ?? row.direction ?? row.upDownCode ?? row.upDown ?? '').trim();
        let direction = 'unknown';
        if (['1', 'S', 'U', '상', '상행'].includes(rawDir)) direction = 'up';
        else if (['2', '0', 'E', 'D', '하', '하행'].includes(rawDir)) direction = 'down';

        return {
          routeNo: row.routeNo ?? row.routeNum ?? '',
          routeNm: row.routeNm ?? row.routeName ?? '',
          startName: row.startPlaceName ?? row.startNodeName ?? row.startName ?? '',
          endName: row.endPlaceName ?? row.endNodeName ?? row.endName ?? '',
          limitSpeed: Number(row.limitSpeed ?? row.speedLimit ?? 0) || null,
          direction,
          rawDirection: rawDir,
          start: Number.isFinite(startLat) && Number.isFinite(startLng) ? { lat: startLat, lng: startLng } : null,
          end: Number.isFinite(endLat) && Number.isFinite(endLng) ? { lat: endLat, lng: endLng } : null,
        };
      })
      .filter((r) => r.start && r.end);

    res.json({ count: normalized.length, sections: normalized });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
