// 全局配置：默认值 + 本地持久化（data/config.json）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './paths.js';

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

/** 4v4 辩手人格：立场一致，但视角、方法论、语言风格各自独立 */
export const DEFAULT_DEBATERS = {
  pro: [
    {
      id: 1,
      name: '陈立',
      style: '学理型，先确立评判标准再展开论证',
      strengths: '概念界定、逻辑框架搭建、把辩题拆成可证伪的子命题',
      tone: '沉稳条理，常用「我方认为，理由有三」',
    },
    {
      id: 2,
      name: '林砚',
      style: '实证型，靠研究和具体案例说话',
      strengths: '引用认知科学与教育心理学的实证结果、拆解对方数据口径',
      tone: '冷静克制，先复述对方观点再逐条击破',
    },
    {
      id: 3,
      name: '周锐',
      style: '攻击型，专抓对方论据里的隐藏前提',
      strengths: '连续追问、设置二难、逼对方承认极端情形',
      tone: '短句锐利，多用反问',
    },
    {
      id: 4,
      name: '何知远',
      style: '价值型，善于把技术争论拉回人的成长',
      strengths: '收官升华、归纳全场交锋、正面回应对方最强论点',
      tone: '从容有感染力，收尾有力',
    },
  ],
  con: [
    {
      id: 1,
      name: '苏迟',
      style: '经验型，从真实课堂与学习过程切入',
      strengths: '界定「思考力」的心理机制、用学习科学立标准',
      tone: '平实有画面感，善用类比',
    },
    {
      id: 2,
      name: '程未',
      style: '反证型，专攻对方论据的反面案例与幸存者偏差',
      strengths: '统计陷阱识别、认知负债与元认知研究、拆解「提分等于提思考力」',
      tone: '锋利爱对照，先把对方推到极端再反驳',
    },
    {
      id: 3,
      name: '许珂',
      style: '追问型，擅长让对方在定义上自相矛盾',
      strengths: '界定边界、逼问「什么才算提升」、设套取证',
      tone: '礼貌但步步紧逼，常用「请对方辩友正面回答」',
    },
    {
      id: 4,
      name: '江晚',
      style: '人文型，落点在教育的目的与人的主体性',
      strengths: '价值收束、回应价值层面的挑战、给出可操作主张',
      tone: '温和坚定，善用排比收尾',
    },
  ],
};

/** 环节类型 → 中文名 */
export const STAGE_LABEL = {
  opening: '立论陈词',
  rebuttal: '驳论',
  crossQ: '质询',
  crossA: '应答质询',
  crossSummary: '质询小结',
  free: '自由辩论',
  final: '总结陈词',
};

export const DEFAULT_CONFIG = {
  topic: '高中生使用 AI 辅助学习，提升了 / 降低了思考力',
  proStance: '高中生使用 AI 辅助学习提升了思考力',
  conStance: '高中生使用 AI 辅助学习降低了思考力',

  // 模型：默认高强度思考（deepseek-reasoner）
  model: 'deepseek-reasoner',
  reasoningEffort: 'high', // off | low | medium | high
  temperature: 1.0,
  baseUrl: 'https://api.deepseek.com',
  maxOutputTokens: 8192,
  requestTimeoutMs: 300000,

  // 赛制（新国辩四对四标准赛制），单位：分钟
  rounds: 3, // 自由辩论交替轮数
  wordsPerMinute: 240, // 真人中文辩论语速，用于折算字数
  minutes: {
    opening: 3,
    rebuttal: 2,
    crossQ: 1.5,
    crossA: 2,
    crossSummary: 1.5,
    free: 1,
    final: 3.5,
  },
  hardWordCap: 1200, // 单次发言硬上限

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

  // 跨场记忆：每位辩手保留最近 N 场的复盘经验，并在下一场开场前注入
  memory: { enabled: true, rounds: 4 },
  // 系列赛：打完一场自动开下一场，记忆累积
  seriesMatches: 4,

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

/* ---------------- 赛制 ---------------- */

export function cn(n) {
  return ['', '一', '二', '三', '四', '五', '六', '七', '八'][n] || String(n);
}

export function speakerLabel(side, id) {
  return `${side === 'pro' ? '正方' : '反方'}${cn(id)}辩`;
}

export function sideName(side) {
  return side === 'pro' ? '正方' : '反方';
}

/**
 * 四对四标准赛制（参照华语辩论世界杯 / 新国辩流程）：
 *   立论 3:00 → 驳论 2:00 → 质询 1:30 / 应答 2:00 → 质询小结 1:30
 *   → 自由辩论（双方交替，各 30 秒一段）→ 总结 3:30（反方先手，正方收尾）
 */
export function buildPhases(config) {
  const wpm = Number(config.wordsPerMinute) || 240;
  const m = config.minutes || {};
  const cap = Number(config.hardWordCap) || 1200;
  const words = (min) => Math.min(cap, Math.max(80, Math.round(min * wpm)));

  const phases = [];
  const push = (type, side, speaker, minutes, extra = {}) => {
    const label = speakerLabel(side, speaker);
    const stage = STAGE_LABEL[type] || type;
    const index = phases.length;
    phases.push({
      index,
      key: `${side}-${type}-${speaker}${extra.round ? `-${extra.round}` : ''}`,
      type,
      side,
      speaker,
      speakerLabel: label,
      stage,
      title: `${label} · ${stage}`,
      minutes,
      seconds: Math.round(minutes * 60),
      words: words(minutes),
      status: 'pending',
      ...extra,
    });
    return phases[phases.length - 1];
  };

  // 立论
  push('opening', 'pro', 1, m.opening ?? 3);
  push('opening', 'con', 1, m.opening ?? 3);

  // 驳论
  push('rebuttal', 'pro', 2, m.rebuttal ?? 2);
  push('rebuttal', 'con', 2, m.rebuttal ?? 2);

  // 质询：正方三辩质询 → 反方三辩作答 → 反方三辩质询 → 正方三辩作答
  push('crossQ', 'pro', 3, m.crossQ ?? 1.5, { target: 'con' });
  push('crossA', 'con', 3, m.crossA ?? 2, { target: 'pro' });
  push('crossQ', 'con', 3, m.crossQ ?? 1.5, { target: 'pro' });
  push('crossA', 'pro', 3, m.crossA ?? 2, { target: 'con' });

  // 质询小结（一辩）
  push('crossSummary', 'pro', 1, m.crossSummary ?? 1.5);
  push('crossSummary', 'con', 1, m.crossSummary ?? 1.5);

  // 自由辩论：正方先行，双方交替
  const rounds = Math.max(1, Math.min(10, Number(config.rounds) || 3));
  for (let r = 1; r <= rounds; r++) {
    push('free', 'pro', ((r - 1) % 4) + 1, m.free ?? 0.5, { round: r });
    push('free', 'con', ((r - 1) % 4) + 1, m.free ?? 0.5, { round: r });
  }

  // 总结：反方先，正方后（标准顺序）
  push('final', 'con', 4, m.final ?? 3.5);
  push('final', 'pro', 4, m.final ?? 3.5);

  return phases;
}

/** 供提示词使用的赛制清单（与实际环节表同源，永不脱节） */
export function formatFlow(config) {
  const phases = buildPhases(config);
  return phases
    .map((p) => {
      const mm = Math.floor(p.minutes);
      const ss = String(Math.round((p.minutes - mm) * 60)).padStart(2, '0');
      const round = p.type === 'free' ? `（第 ${p.round} 段）` : '';
      return `${p.index + 1}. ${p.title}${round} — ${mm}:${ss}`;
    })
    .join('\n');
}

export function totalMinutes(config) {
  return buildPhases(config).reduce((a, p) => a + p.minutes, 0);
}

/** 思考强度 → 实际模型 */
export function resolveModel(config) {
  const explicit = String(config.model || '');
  if (/reasoner/i.test(explicit)) return 'deepseek-reasoner';
  const effort = config.reasoningEffort || 'high';
  if (effort === 'medium' || effort === 'high') return 'deepseek-reasoner';
  return 'deepseek-chat';
}

/** 高强度时附加在任务末尾的一句话（不进入历史，仅影响本轮） */
export function effortHint(config) {
  const effort = config.reasoningEffort || 'high';
  if (effort === 'high') return '落笔前先在心里比较双方最强的论点，再选择最难被反驳的表达。';
  if (effort === 'medium') return '先想清楚这一轮要打掉哪一点，再落笔。';
  return '';
}
