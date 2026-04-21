import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const EX_API_KEY = process.env.EX_API_KEY || 'test';
const EX_API_BASE = 'http://data.ex.co.kr/openapi/safetyDriving/safeSecCameraList';

const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
  });
  res.end(data);
}

async function serveStatic(req, res) {
  // "/" -> "/index.html"
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';

  // 경로 탈출 방지
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\\/])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  try {
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.writeHead(404); res.end('Not Found');
    } else {
      res.writeHead(500); res.end('Internal Error');
    }
  }
}

async function handleSectionCameras(req, res) {
  try {
    const allRows = [];
    let pageNo = 1;
    const numOfRows = 100;

    while (true) {
      const url = `${EX_API_BASE}?key=${encodeURIComponent(EX_API_KEY)}&type=json&numOfRows=${numOfRows}&pageNo=${pageNo}`;
      const r = await fetch(url);
      if (!r.ok) return sendJson(res, 502, { error: `upstream ${r.status}` });

      const text = await r.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return sendJson(res, 502, { error: 'invalid upstream JSON', body: text.slice(0, 300) });
      }

      const list = data.list || data.items || [];
      allRows.push(...list);

      const total = Number(data.totalCount ?? data.count ?? list.length);
      if (allRows.length >= total || list.length === 0) break;
      pageNo += 1;
      if (pageNo > 50) break;
    }

    const normalized = allRows
      .map((row) => {
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

    sendJson(res, 200, { count: normalized.length, sections: normalized });
  } catch (err) {
    sendJson(res, 500, { error: String(err?.message || err) });
  }
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (req.method === 'GET' && pathname === '/api/section-cameras') {
    return handleSectionCameras(req, res);
  }
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}`);
});
