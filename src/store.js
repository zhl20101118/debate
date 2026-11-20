// 本地存储：全量 JSON 落盘，不依赖任何数据库；密钥单独存放且永不入库
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSION_DIR, REPORT_DIR, SECRET_FILE, ensureDirs } from './paths.js';

ensureDirs();

/* ---------------- 密钥 ---------------- */

export function readSecrets() {
  try {
    return JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeSecrets(patch) {
  const next = { ...readSecrets(), ...patch };
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, JSON.stringify(next, null, 2), 'utf8');
  // 尽量收紧权限（Windows 上为 no-op）
  try { fs.chmodSync(SECRET_FILE, 0o600); } catch {}
  return next;
}

/** 优先级：环境变量 > data/secrets.json > 空 */
export function getApiKey() {
  return (
    process.env.DEEPSEEK_API_KEY ||
    readSecrets().deepseekApiKey ||
    ''
  ).trim();
}

export function maskKey(k) {
  if (!k) return '';
  if (k.length <= 10) return '****';
  return `${k.slice(0, 5)}${'*'.repeat(Math.max(4, k.length - 9))}${k.slice(-4)}`;
}

/* ---------------- 会话 ---------------- */

const ID_RE = /^[a-zA-Z0-9_-]{4,64}$/;

function sessionFile(id) {
  if (!ID_RE.test(id)) throw new Error('非法会话 ID');
  return path.join(SESSION_DIR, `${id}.json`);
}

export function newSessionId() {
  return `deb-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

export function saveSession(session) {
  session.updatedAt = Date.now();
  const f = sessionFile(session.id);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  return session;
}

export function loadSession(id) {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8'));
  } catch {
    return null;
  }
}

export function listSessions() {
  try {
    return fs
      .readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
          return {
            id: s.id,
            topic: s.topic,
            status: s.status,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
            progress: `${(s.turns || []).filter((t) => t.status === 'done').length}/${(s.phases || []).length}`,
            totalTokens: s.usage?.totalTokens || 0,
            cacheHitRate: s.usage?.cacheHitRate || 0,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  } catch {
    return [];
  }
}

export function deleteSession(id) {
  try {
    fs.unlinkSync(sessionFile(id));
    const rp = path.join(REPORT_DIR, `${id}.md`);
    if (fs.existsSync(rp)) fs.unlinkSync(rp);
    return true;
  } catch {
    return false;
  }
}

/* ---------------- 报告 ---------------- */

export function saveReport(id, markdown) {
  const f = path.join(REPORT_DIR, `${id}.md`);
  fs.writeFileSync(f, markdown, 'utf8');
  return f;
}

export function loadReport(id) {
  try {
    return fs.readFileSync(path.join(REPORT_DIR, `${id}.md`), 'utf8');
  } catch {
    return null;
  }
}
