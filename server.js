import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const EX_API_KEY = process.env.EX_API_KEY || 'test';
const EX_API_BASE = 'http://data.ex.co.kr/openapi/safetyDriving/safeSecCameraList';

// 사내 프록시 지원: HTTP_PROXY 환경변수가 설정되어 있으면 해당 프록시로 요청
const proxyUrl = process.env.HTTP_PROXY || process.env.http_proxy || process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxyUrl) console.log(`Using proxy: ${proxyUrl}`);

// TLS 검증 우회 (사내 MITM 프록시 환경용). 기본값은 검증 ON.
const INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === '1';
if (INSECURE_TLS) console.warn('WARNING: TLS certificate verification is disabled.');

const MAX_REDIRECTS = 5;

// 프록시에 CONNECT 로 터널링해서 TLS 소켓을 여는 헬퍼 (HTTPS 대상 + 프록시)
function openProxyTunnel(target) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const connectReq = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${Number(target.port) || 443}`,
      headers: { Host: `${target.hostname}:${Number(target.port) || 443}` },
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`proxy CONNECT failed: ${res.statusCode}`));
        return;
      }
      const tlsSock = tls.connect({
        socket,
        servername: target.hostname,
        rejectUnauthorized: !INSECURE_TLS,
      });
      tlsSock.once('secureConnect', () => resolve(tlsSock));
      tlsSock.once('error', reject);
    });
    connectReq.on('error', reject);
    connectReq.setTimeout(15000, () => connectReq.destroy(new Error('proxy CONNECT timeout')));
    connectReq.end();
  });
}

function requestOnce(targetUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const isHttps = target.protocol === 'https:';

    const commonHeaders = {
      Host: target.host,
      'User-Agent': 'speed-camera-map/1.0',
      Accept: '*/*',
      Connection: 'close',
    };

    const collectResponse = (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    };

    if (proxyUrl && !isHttps) {
      // HTTP 대상은 프록시에 절대 URL 로 그대로 전달
      const p = new URL(proxyUrl);
      const req = http.request({
        host: p.hostname,
        port: Number(p.port) || 80,
        method: 'GET',
        path: targetUrl,
        headers: commonHeaders,
      }, collectResponse);
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
      req.end();
      return;
    }

    if (proxyUrl && isHttps) {
      // HTTPS 대상은 프록시에 CONNECT 로 터널 뚫고 그 위에 HTTPS
      openProxyTunnel(target).then((tlsSock) => {
        const req = https.request({
          createConnection: () => tlsSock,
          method: 'GET',
          path: target.pathname + target.search,
          headers: commonHeaders,
          host: target.hostname,
          port: Number(target.port) || 443,
          rejectUnauthorized: !INSECURE_TLS,
        }, collectResponse);
        req.on('error', reject);
        req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
        req.end();
      }, reject);
      return;
    }

    // 프록시 없음 (HTTP or HTTPS 직접)
    const mod = isHttps ? https : http;
    const req = mod.request({
      host: target.hostname,
      port: Number(target.port) || (isHttps ? 443 : 80),
      method: 'GET',
      path: target.pathname + target.search,
      headers: commonHeaders,
      rejectUnauthorized: isHttps ? !INSECURE_TLS : undefined,
    }, collectResponse);
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

async function httpGet(startUrl) {
  let current = startUrl;
  const chain = [current];
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    let r;
    try {
      r = await requestOnce(current);
    } catch (err) {
      err.attemptedUrl = current;
      err.redirectChain = chain;
      throw err;
    }
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      const next = new URL(r.headers.location, current).toString();
      console.log(`[${r.status}] redirect -> ${next}`);
      chain.push(next);
      current = next;
      continue;
    }
    return r;
  }
  const err = new Error('too many redirects');
  err.redirectChain = chain;
  throw err;
}

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
      const r = await httpGet(url);
      if (r.status < 200 || r.status >= 300) {
        return sendJson(res, 502, { error: `upstream ${r.status}`, body: r.body.slice(0, 300) });
      }

      let data;
      try {
        data = JSON.parse(r.body);
      } catch {
        return sendJson(res, 502, { error: 'invalid upstream JSON', body: r.body.slice(0, 300) });
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
    console.error('upstream error:', err);
    sendJson(res, 500, {
      error: String(err?.message || err),
      code: err?.code || null,
      attemptedUrl: err?.attemptedUrl || null,
      redirectChain: err?.redirectChain || null,
      hint: proxyUrl
        ? '프록시 경유 호출이 실패했습니다. TLS 에러면 ALLOW_INSECURE_TLS=1 를 시도해 보세요 (사내 MITM 프록시 대응).'
        : '사내망에서 data.ex.co.kr 직접 호출이 막혀있을 수 있습니다. HTTP_PROXY 환경변수로 사내 프록시를 지정해 보세요.',
    });
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
  if (!process.env.NODE_OPTIONS?.includes('openssl-config')) {
    console.log('Tip: data.ex.co.kr 이 약한 CA 를 써서 TLS 가 실패하면 run.bat 으로 실행하세요 (OpenSSL SECLEVEL=0).');
  }
});
