// 零依赖 HTTP 服务：静态页面 + REST + SSE 实时推送
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PUBLIC_DIR } from './src/paths.js';
import { ensureConfig, readConfig, writeConfig, resetConfig, DEFAULT_CONFIG } from './src/config.js';
import {
  saveSession, loadSession, listSessions, deleteSession, loadReport,
  newSessionId, getApiKey, writeSecrets, readSecrets, maskKey,
} from './src/store.js';
import {
  createSession, startRunner, controlSession, getRunner, collectSources,
} from './src/orchestrator.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim();

/* ---------------- SSE 总线 ---------------- */

const subscribers = new Map(); // sessionId -> Set(res)

function broadcast(sessionId, type, data) {
  const set = subscribers.get(sessionId);
  if (!set?.size) return;
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch { set.delete(res); }
  }
}

function makeEmitter(sessionId) {
  return (type, data) => broadcast(sessionId, type, data);
}

/* ---------------- 工具 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, code, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(text);
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function requireAdmin(req, res) {
  if (!ADMIN_TOKEN) return true;
  const token = req.headers['x-admin-token'] || '';
  if (token === ADMIN_TOKEN) return true;
  sendJson(res, 403, { ok: false, message: '管理口令不正确' });
  return false;
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = decodeURIComponent(rel).replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Forbidden');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA 兜底
      const index = path.join(PUBLIC_DIR, 'index.html');
      if (fs.existsSync(index)) {
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        fs.createReadStream(index).pipe(res);
      } else {
        sendText(res, 404, 'Not Found');
      }
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

/* ---------------- 路由 ---------------- */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  // ---- SSE ----
  const streamMatch = p.match(/^\/api\/sessions\/([\w-]+)\/stream$/);
  if (streamMatch && method === 'GET') {
    const id = streamMatch[1];
    const session = loadSession(id);
    if (!session) return sendJson(res, 404, { ok: false, message: '会话不存在' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    if (!subscribers.has(id)) subscribers.set(id, new Set());
    subscribers.get(id).add(res);

    // 连上先给一份快照，避免刷新丢失
    res.write(`event: snapshot\ndata: ${JSON.stringify(publicSession(session))}\n\n`);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch {}
    }, 15000);

    req.on('close', () => {
      clearInterval(ping);
      subscribers.get(id)?.delete(res);
    });
    return;
  }

  // ---- 配置 ----
  if (p === '/api/config' && method === 'GET') {
    const cfg = readConfig();
    return sendJson(res, 200, { ok: true, config: cfg, defaults: DEFAULT_CONFIG });
  }
  if (p === '/api/config' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const patch = await readBody(req);
    return sendJson(res, 200, { ok: true, config: writeConfig(patch) });
  }
  if (p === '/api/config/reset' && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    return sendJson(res, 200, { ok: true, config: resetConfig() });
  }

  // ---- 密钥 ----
  if (p === '/api/secrets' && method === 'GET') {
    const k = getApiKey();
    return sendJson(res, 200, {
      ok: true,
      configured: Boolean(k),
      masked: maskKey(k),
      source: process.env.DEEPSEEK_API_KEY ? 'env' : (readSecrets().deepseekApiKey ? 'file' : 'none'),
      adminRequired: Boolean(ADMIN_TOKEN),
    });
  }
  if (p === '/api/secrets' && method === 'POST') {
    const body = await readBody(req);
    const key = String(body.deepseekApiKey || '').trim();
    if (!key) return sendJson(res, 400, { ok: false, message: 'Key 为空' });
    if (!/^sk-[A-Za-z0-9_-]{10,}$/.test(key)) {
      return sendJson(res, 400, { ok: false, message: 'Key 格式看起来不对（应以 sk- 开头）' });
    }
    writeSecrets({ deepseekApiKey: key });
    return sendJson(res, 200, { ok: true, configured: true, masked: maskKey(key), source: 'file' });
  }
  if (p === '/api/secrets' && method === 'DELETE') {
    writeSecrets({ deepseekApiKey: '' });
    return sendJson(res, 200, { ok: true, configured: false });
  }

  // ---- 会话列表 ----
  if (p === '/api/sessions' && method === 'GET') {
    return sendJson(res, 200, { ok: true, sessions: listSessions() });
  }

  // ---- 新建会话 ----
  if (p === '/api/sessions' && method === 'POST') {
    const body = await readBody(req);
    const cfg = writeConfig(body.config || {});
    const id = newSessionId();
    const session = createSession(cfg, { id });
    if (body.autoStart) {
      session.status = 'running';
    }
    saveSession(session);

    const emit = makeEmitter(id);
    if (body.autoStart) {
      // 稍等前端建立 SSE 再开跑
      setTimeout(() => startRunner(session, emit), 600);
    }
    return sendJson(res, 200, { ok: true, id, session: publicSession(session) });
  }

  // ---- 单个会话 ----
  const one = p.match(/^\/api\/sessions\/([\w-]+)$/);
  if (one) {
    const id = one[1];
    const session = loadSession(id);
    if (!session) return sendJson(res, 404, { ok: false, message: '会话不存在' });

    if (method === 'GET') {
      // 服务器重启过：把「running」纠正为 paused，避免假装在跑
      if ((session.status === 'running' || session.status === 'researching') && !getRunner(id)) {
        session.status = 'paused';
        saveSession(session);
      }
      return sendJson(res, 200, { ok: true, session: publicSession(session) });
    }
    if (method === 'DELETE') {
      const r = getRunner(id);
      if (r) r.abort();
      deleteSession(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ---- 控制 ----
  const ctl = p.match(/^\/api\/sessions\/([\w-]+)\/control$/);
  if (ctl && method === 'POST') {
    if (!requireAdmin(req, res)) return;
    const id = ctl[1];
    const session = loadSession(id);
    if (!session) return sendJson(res, 404, { ok: false, message: '会话不存在' });
    const body = await readBody(req);
    const emit = makeEmitter(id);
    try {
      const out = controlSession(session, String(body.action || ''), body, emit);
      saveSession(session);
      return sendJson(res, 200, { ok: out.ok !== false, message: out.message || '', session: publicSession(session) });
    } catch (e) {
      return sendJson(res, 500, { ok: false, message: e.message });
    }
  }

  // ---- 报告 ----
  const rep = p.match(/^\/api\/sessions\/([\w-]+)\/report$/);
  if (rep && method === 'GET') {
    const id = rep[1];
    const md = loadReport(id);
    if (!md) return sendJson(res, 404, { ok: false, message: '报告尚未生成' });
    if (url.searchParams.get('download')) {
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="debate-${id}.md"`,
      });
      return res.end(md);
    }
    return sendText(res, 200, md, 'text/markdown; charset=utf-8');
  }

  // ---- 来源 ----
  const src = p.match(/^\/api\/sessions\/([\w-]+)\/sources$/);
  if (src && method === 'GET') {
    const session = loadSession(src[1]);
    if (!session) return sendJson(res, 404, { ok: false, message: '会话不存在' });
    return sendJson(res, 200, { ok: true, sources: collectSources(session) });
  }

  // ---- 健康检查 ----
  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, uptime: process.uptime(), adminRequired: Boolean(ADMIN_TOKEN) });
  }

  if (p.startsWith('/api/')) return sendJson(res, 404, { ok: false, message: '接口不存在' });
  return serveStatic(req, res, p);
}

/** 去掉不需要发给前端的字段，减小体积 */
function publicSession(s) {
  return {
    id: s.id,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    topic: s.topic,
    config: {
      model: s.config.model,
      reasoningEffort: s.config.reasoningEffort,
      rounds: s.config.rounds,
      wordsPerMinute: s.config.wordsPerMinute,
      searchEnabled: s.config.searchEnabled,
      conciseContext: s.config.conciseContext,
      proStance: s.config.proStance,
      conStance: s.config.conStance,
    },
    phases: s.phases,
    turns: s.turns,
    research: s.research,
    status: s.status,
    currentPhaseIndex: s.currentPhaseIndex,
    judge: s.judge,
    report: s.report,
    error: s.error,
    usage: s.usage,
  };
}

/* ---------------- 启动 ---------------- */

function localIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function main() {
  ensureConfig();
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[error]', e);
      if (!res.headersSent) sendJson(res, 500, { ok: false, message: e.message });
      else res.end();
    });
  });

  server.listen(PORT, HOST, () => {
    const ips = localIPs();
    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║        AI 辩论室 · 4 v 4 已启动          ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log(`  本机访问 : http://localhost:${PORT}`);
    for (const ip of ips) console.log(`  局域网   : http://${ip}:${PORT}`);
    console.log('');
    console.log(`  API Key  : ${getApiKey() ? maskKey(getApiKey()) : '未配置（请到网页「设置」里填）'}`);
    console.log(`  数据目录 : ${path.join(process.cwd(), 'data')}`);
    console.log(`  管理口令 : ${ADMIN_TOKEN ? '已启用' : '未设置（任何人可控制进度）'}`);
    console.log('');
  });
}

main();
