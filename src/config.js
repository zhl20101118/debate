// 全局配置：默认值 + 本地持久化（data/config.json）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** 4v4 辩手人格：每个人的「记忆」都不同，立场一致但视角、方法论、语言风格分开 */
export const DEFAULT_DEBATERS = {
  pro: [
    {
      id: 1,
      name: '陈立',
      role: '一辩 · 立论',
      style: '学理型，善于先确立评判标准再展开论证',
      strengths: '概念界定、逻辑框架搭建、把辩题拆成可证伪的子命题',
      tone: '沉稳、条理清晰，常用「我方认为……理由有三」',
    },
    {
      id: 2,
      name: '林砚',
      role: '二辩 · 驳论',
      style: '实证型，靠数据和具体案例说话',
      strengths: '引用教育心理学与认知科学的实证研究、拆解对方数据口径',
      tone: '冷静克制，先复述对方观点再逐条击破',
    },
    {
      id: 3,
      name: '周锐',
      role: '三辩 · 质询',
      style: '攻击型，专抓对方论据里的隐藏前提',
      strengths: '连续追问、设置二难、逼对方承认极端情形',
      tone: '短句、锐利，多用反问句',
    },
    {
      id: 4,
      name: '何知远',
      role: '四辩 · 总结',
      style: '价值型，善于把技术争论拉回人的成长',
      strengths: '收官升华、归纳全场交锋、回应对方最强论点',
      tone: '从容有感染力，收尾有力',
    },
  ],
  con: [
    {
      id: 1,
      name: '苏迟',
      role: '一辩 · 立论',
      style: '经验型，从真实课堂与学习过程切入',
      strengths: '界定「思考力」的心理机制、用学习科学立标准',
      tone: '平实、有画面感，善用类比',
    },
    {
      id: 2,
      name: '程未',
      role: '二辩 · 驳论',
      style: '反证型，专攻对方论据的反面案例与幸存者偏差',
      strengths: '统计陷阱识别、认知负债与元认知研究、拆解「提分等于提思考力」',
      tone: '锋利、爱用对照，先把对方推到极端再反驳',
    },
    {
      id: 3,
      name: '许珂',
      role: '三辩 · 质询',
      style: '追问型，擅长让对方在定义上自相矛盾',
      strengths: '界定边界、逼问「什么才算提升了思考力」、设套取证',
      tone: '礼貌但步步紧逼，常用「请对方辩友正面回答」',
    },
    {
      id: 4,
      name: '江晚',
      role: '四辩 · 总结',
      style: '人文型，落点在教育的目的与人的主体性',
      strengths: '价值收束、回应对方价值层面的挑战、给出可操作主张',
      tone: '温和坚定，善用排比收尾',
    },
  ],
};

export const DEFAULT_CONFIG = {
  topic: '高中生使用 AI 辅助学习，提升了 / 降低了思考力',
  proStance: '高中生使用 AI 辅助学习提升了思考力',
  conStance: '高中生使用 AI 辅助学习降低了思考力',

  // 模型
  model: 'deepseek-chat',
  reasoningEffort: 'medium', // off | low | medium | high
  temperature: 1.0,
  baseUrl: 'https://api.deepseek.com',

  // 赛制
  rounds: 3, // 自由辩论轮数
  wordsPerMinute: 240, // 真人中文辩论语速，用于折算字数
  minutes: {
    opening: 3,
    rebuttal: 2,
    crossQ: 1.5,
    crossA: 1,
    free: 0.7,
    summary: 3.5,
  },
  maxOutputTokens: 3200,
  hardWordCap: 1100, // 单次发言硬上限，防止 AI 长篇大论

  // 资料检索
  searchEnabled: true,
  searchQueries: 5,
  searchPerQuery: 4,
  fetchPages: 3,
  authorityDomains: [
    'edu.cn', 'gov.cn', 'cnki.net', 'cqvip.com', 'wanfangdata.com.cn',
    'arxiv.org', 'nature.com', 'science.org', 'springer.com', 'sciencedirect.com',
    'who.int', 'unesco.org', 'oecd.org', 'worldbank.org', 'aeaweb.org',
    'apa.org', 'nber.org', 'moe.gov.cn', 'cnnic.net.cn', 'cas.cn',
    'hbr.org', 'mckinsey.com', 'brookings.edu', 'pewresearch.org',
  ],

  // 上下文策略
  conciseContext: false, // true 时只喂最近发言（更省，但会牺牲缓存命中）
  sharedPrefixCache: true, // 关键：所有辩手共享同一段前缀，保证 DeepSeek 前缀缓存命中
  autoReport: true,
  judgeEnabled: true,

  debaters: DEFAULT_DEBATERS,
};

export function ensureConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  }
  return readConfig();
}

export function readConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return deepMerge(structuredClone(DEFAULT_CONFIG), raw);
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function writeConfig(patch) {
  const merged = deepMerge(readConfig(), patch || {});
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

export function resetConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  return structuredClone(DEFAULT_CONFIG);
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(base[k])) base[k] = deepMerge(base[k], v);
    else if (v !== undefined) base[k] = v;
  }
  return base;
}

/** 按赛制把「自由辩论轮数」展开成完整环节表 */
export function buildPhases(config) {
  const wpm = Number(config.wordsPerMinute) || 240;
  const m = config.minutes;
  const w = (min) => Math.min(config.hardWordCap, Math.max(90, Math.round(min * wpm)));

  const phases = [];
  const push = (p) => phases.push({ index: phases.length, status: 'pending', ...p });

  push({ key: 'pro-opening', type: 'opening', side: 'pro', speaker: 1, title: '正方一辩 · 立论陈词', words: w(m.opening) });
  push({ key: 'con-opening', type: 'opening', side: 'con', speaker: 1, title: '反方一辩 · 立论陈词', words: w(m.opening) });
  push({ key: 'pro-rebuttal', type: 'rebuttal', side: 'pro', speaker: 2, title: '正方二辩 · 驳论', words: w(m.rebuttal) });
  push({ key: 'con-rebuttal', type: 'rebuttal', side: 'con', speaker: 2, title: '反方二辩 · 驳论', words: w(m.rebuttal) });

  // 攻辩（质询）：正方三辩质询 → 反方三辩应答 → 反方三辩质询 → 正方三辩应答
  push({ key: 'pro-cross-q', type: 'crossQ', side: 'pro', speaker: 3, title: '正方三辩 · 质询', words: w(m.crossQ) });
  push({ key: 'con-cross-a', type: 'crossA', side: 'con', speaker: 3, title: '反方三辩 · 应答质询', words: w(m.crossA) });
  push({ key: 'con-cross-q', type: 'crossQ', side: 'con', speaker: 3, title: '反方三辩 · 质询', words: w(m.crossQ) });
  push({ key: 'pro-cross-a', type: 'crossA', side: 'pro', speaker: 3, title: '正方三辩 · 应答质询', words: w(m.crossA) });

  const rounds = Math.max(1, Math.min(10, Number(config.rounds) || 3));
  for (let r = 1; r <= rounds; r++) {
    const proSpeaker = ((r - 1) % 4) + 1;
    const conSpeaker = ((r - 1) % 4) + 1;
    push({
      key: `free-pro-${r}`, type: 'free', side: 'pro', speaker: proSpeaker, round: r,
      title: `自由辩论 第${r}轮 · 正方${cn(proSpeaker)}`, words: w(m.free),
    });
    push({
      key: `free-con-${r}`, type: 'free', side: 'con', speaker: conSpeaker, round: r,
      title: `自由辩论 第${r}轮 · 反方${cn(conSpeaker)}`, words: w(m.free),
    });
  }

  push({ key: 'con-summary', type: 'summary', side: 'con', speaker: 4, title: '反方四辩 · 总结陈词', words: w(m.summary) });
  push({ key: 'pro-summary', type: 'summary', side: 'pro', speaker: 4, title: '正方四辩 · 总结陈词', words: w(m.summary) });

  return phases;
}

export function cn(n) {
  return ['', '一', '二', '三', '四', '五', '六'][n] || String(n);
}
