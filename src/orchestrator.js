// 辩论调度器：4v4 赛制状态机 + 可控执行 + 流式事件 + 用量统计
import { buildPhases, cn } from './config.js';
import { streamChat } from './deepseek.js';
import { search, fetchPageDigest } from './search.js';
import {
  buildMessages,
  buildTurnTask,
  buildResearchTask,
  buildJudgeTask,
  buildReportTask,
} from './prompts.js';
import { saveSession, saveReport, loadReport, getApiKey } from './store.js';

// 估算单价（元 / 百万 token），可按需调整
const PRICING = {
  'deepseek-chat': { hit: 0.2, miss: 2.0, out: 3.0 },
  'deepseek-reasoner': { hit: 0.2, miss: 2.0, out: 3.0 },
};

const EFFORT = {
  off: { model: 'deepseek-chat', hint: '', temperature: 1.05 },
  low: { model: 'deepseek-chat', hint: '（可直接作答，不必展开长篇推理）', temperature: 1.0 },
  medium: { model: 'deepseek-reasoner', hint: '', temperature: 1.0 },
  high: { model: 'deepseek-reasoner', hint: '（请充分权衡双方最强论点后再落笔）', temperature: 1.0 },
};

const runners = new Map();

export function createSession(config, overrides = {}) {
  const merged = { ...config, ...overrides, debaters: config.debaters };
  const phases = buildPhases(merged).map((p, i) => ({ ...p, index: i }));
  const session = {
    id: overrides.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    topic: merged.topic,
    config: merged,
    phases,
    turns: [],
    research: { pro: [], con: [] },
    status: 'idle',
    currentPhaseIndex: 0,
    judge: '',
    report: '',
    reportFile: '',
    interventionQueue: [],
    error: null,
    usage: emptyUsage(),
  };
  return session;
}

function emptyUsage() {
  return {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheHitRate: 0,
    costEstimate: 0,
  };
}

function accUsage(session, usage, model) {
  if (!usage) return;
  const u = session.usage;
  u.calls += 1;
  u.promptTokens += usage.promptTokens || 0;
  u.completionTokens += usage.completionTokens || 0;
  u.reasoningTokens += usage.reasoningTokens || 0;
  u.totalTokens += usage.totalTokens || 0;
  u.cacheHitTokens += usage.cacheHitTokens || 0;
  u.cacheMissTokens += usage.cacheMissTokens || 0;
  const denom = u.cacheHitTokens + u.cacheMissTokens;
  u.cacheHitRate = denom ? u.cacheHitTokens / denom : 0;
  const p = PRICING[model] || PRICING['deepseek-chat'];
  u.costEstimate =
    (u.cacheHitTokens / 1e6) * p.hit +
    (u.cacheMissTokens / 1e6) * p.miss +
    (u.completionTokens / 1e6) * p.out;
}

function countWords(text) {
  return (text || '').replace(/\s/g, '').length;
}

/** 从发言里抽 3-4 条「论点」句子，作为本方记忆的锚点 */
function extractClaims(text, max = 4) {
  const paras = (text || '')
    .split(/\n+/)
    .map((s) => s.replace(/^[-·•\d①-⑨.、）)]+\s*/, '').trim())
    .filter((s) => s.length >= 12 && s.length <= 220);
  return paras.slice(0, max).map((s) => (s.length > 56 ? `${s.slice(0, 56)}…` : s));
}

class Runner {
  constructor(session, emit) {
    this.session = session;
    this.emit = emit;
    this.aborted = false;
    this.paused = false;
    this.stepOnce = false;
    this._waiters = [];
    this._ctrl = null;
  }

  pause() {
    this.paused = true;
    this.emit('state', { status: 'paused' });
    this.save();
  }

  resume() {
    this.paused = false;
    this.emit('state', { status: 'running' });
    this._waiters.splice(0).forEach((r) => r());
  }

  abort() {
    this.aborted = true;
    this.resume();
    try { this._ctrl?.abort(); } catch {}
  }

  async gate() {
    if (!this.paused || this.aborted) return;
    await new Promise((resolve) => this._waiters.push(resolve));
  }

  save() {
    try { saveSession(this.session); } catch (e) { console.error('保存失败', e.message); }
  }

  log(message, level = 'info') {
    this.emit('log', { level, message, at: Date.now() });
  }

  nextPhase() {
    return this.session.phases.find((p) => p.status === 'pending');
  }

  async run() {
    const s = this.session;
    s.status = 'running';
    s.error = null;
    this.emit('state', { status: 'running' });
    this.save();

    try {
      if (!Object.keys(s.research?.pro || {}).length && s.config.searchEnabled && !s.researchDone) {
        await this.research();
      }

      while (!this.aborted) {
        await this.gate();
        if (this.aborted) break;
        const phase = this.nextPhase();
        if (!phase) break;
        await this.runPhase(phase);
        if (this.stepOnce) {
          this.stepOnce = false;
          this.pause();
        }
      }

      if (!this.aborted && !this.nextPhase()) {
        await this.conclude();
      }
    } catch (err) {
      s.status = 'error';
      s.error = err.message;
      this.emit('error', { message: err.message, status: err.status || 0 });
      this.emit('state', { status: 'error' });
    } finally {
      this.save();
    }
  }

  /* ---------- 资料检索 ---------- */

  async research() {
    const s = this.session;
    const cfg = s.config;
    this.log('开始检索权威资料…');
    this.emit('state', { status: 'researching' });

    let queries = [];
    try {
      const task = buildResearchTask(s, cfg);
      const r = await streamChat({
        apiKey: getApiKey(),
        baseUrl: cfg.baseUrl,
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是辩论队的资料研究员，只输出检索式，每行一条，不要编号和解释。' },
          { role: 'user', content: task },
        ],
        maxTokens: 300,
        temperature: 0.7,
      });
      queries = r.content
        .split(/\n+/)
        .map((x) => x.replace(/^[\d.、\-*]\s*/, '').trim())
        .filter((x) => x.length >= 4 && x.length <= 40)
        .slice(0, cfg.searchQueries || 5);
      accUsage(s, r.usage, 'deepseek-chat');
      this.emit('usage', s.usage);
    } catch (e) {
      this.log(`检索式生成失败，改用内置检索式：${e.message}`, 'warn');
    }

    const topicHint = cfg.topic.slice(0, 24);
    if (!queries.length) {
      queries = [`${topicHint} 研究`, `${topicHint} 影响 数据`, '生成式人工智能 学习 认知'];
    }

    const proQueries = ['AI 辅助学习 批判性思维 提升 研究', '生成式AI 学习效果 元分析 学生'];
    const conQueries = ['AI 依赖 认知卸载 学习 风险', 'ChatGPT 使用 学生 思维能力 下降 研究'];

    const keys = { tavily: process.env.TAVILY_API_KEY, serper: process.env.SERPER_API_KEY };
    const doSearch = async (list) => {
      const all = [];
      for (const q of list) {
        try {
          const rows = await search(q, {
            limit: cfg.searchPerQuery || 4,
            authorityDomains: cfg.authorityDomains,
            keys,
          });
          rows.forEach((r) => all.push({ ...r, query: q }));
          this.log(`检索「${q}」→ ${rows.length} 条`);
        } catch (e) {
          this.log(`检索「${q}」失败：${e.message}`, 'warn');
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      return all;
    };

    const [generic, proOnly, conOnly] = await Promise.all([
      doSearch(queries),
      doSearch(proQueries),
      doSearch(conQueries),
    ]);

    const pick = (pool, extra) => {
      const seen = new Set();
      const merged = [...extra, ...pool].filter((r) => {
        if (!r.url || seen.has(r.url)) return false;
        seen.add(r.url);
        return true;
      });
      return merged.sort((a, b) => b.score - a.score).slice(0, 8);
    };

    s.research.pro = pick(generic, proOnly);
    s.research.con = pick(generic, conOnly);
    s.researchDone = true;

    // 抓正文，让论据更实（限流，避免拖慢开场）
    for (const side of ['pro', 'con']) {
      const cards = s.research[side].slice(0, cfg.fetchPages || 3);
      await Promise.all(
        cards.map(async (c) => {
          if (!c.url) return;
          const digest = await fetchPageDigest(c.url, 1500);
          if (digest) c.digest = digest;
        })
      );
      this.emit('research', { side, cards: s.research[side] });
    }

    this.log(
      `资料检索完成：正方 ${s.research.pro.length} 条，反方 ${s.research.con.length} 条`
    );
    this.save();
    this.emit('state', { status: 'running' });
  }

  /* ---------- 单个环节 ---------- */

  async runPhase(phase) {
    const s = this.session;
    const cfg = s.config;
    const eff = EFFORT[cfg.reasoningEffort] || EFFORT.off;
    // 思考强度决定是否启用推理模型；显式选 reasoner 时强制启用
    const model = cfg.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : eff.model;
    const sideName = phase.side === 'pro' ? '正方' : '反方';
    const me = cfg.debaters[phase.side].find((d) => d.id === phase.speaker);

    phase.status = 'running';
    s.currentPhaseIndex = phase.index;
    this.emit('phase', { phase: { ...phase } });
    this.emit('state', { status: 'running', currentPhaseIndex: phase.index, current: phase.title });

    const intervention = s.interventionQueue.shift() || '';
    const taskText = buildTurnTask({ session: s, phase, config: cfg }) + (eff.hint ? `\n${eff.hint}` : '');
    const messages = buildMessages({
      session: s,
      config: cfg,
      taskText,
      concise: cfg.conciseContext,
    });

    this.emit('turn_start', {
      phaseIndex: phase.index,
      title: phase.title,
      side: phase.side,
      speaker: phase.speaker,
      speakerName: me?.name || '',
      role: me?.role || '',
      words: phase.words,
    });

    const startedAt = Date.now();
    let content = '';
    let reasoning = '';
    let usage = null;

    this._ctrl = new AbortController();
    try {
      const res = await streamChat({
        apiKey: getApiKey(),
        baseUrl: cfg.baseUrl,
        model,
        messages,
        maxTokens: cfg.maxOutputTokens || 2600,
        temperature: cfg.temperature ?? 1.0,
        thinking: model === 'deepseek-reasoner',
        signal: this._ctrl.signal,
        onDelta: (d) => {
          this.emit('delta', {
            phaseIndex: phase.index,
            kind: d.type,
            text: d.text,
          });
        },
      });
      content = res.content;
      reasoning = res.reasoning;
      usage = res.usage;
    } catch (err) {
      phase.status = 'error';
      phase.error = err.message;
      this.emit('phase', { phase: { ...phase } });
      this.emit('turn_error', { phaseIndex: phase.index, message: err.message });
      this.save();
      throw err;
    }

    const order = s.turns.filter((t) => t.status === 'done').length + 1;
    const turn = {
      order,
      phaseIndex: phase.index,
      phaseKey: phase.key,
      title: phase.title,
      type: phase.type,
      side: phase.side,
      speaker: phase.speaker,
      round: phase.round || null,
      role: me?.role || `${sideName}${cn(phase.speaker)}辩`,
      speakerName: me?.name || `${sideName}${cn(phase.speaker)}辩`,
      content,
      reasoning: reasoning && reasoning.trim() ? reasoning : '',
      status: 'done',
      words: countWords(content),
      wordTarget: phase.words,
      claims: extractClaims(content),
      intervention: intervention || undefined,
      usage: usage || null,
      model,
      startedAt,
      endedAt: Date.now(),
    };

    s.turns.push(turn);
    phase.status = 'done';
    accUsage(s, usage, model);

    this.emit('turn_done', { turn });
    this.emit('phase', { phase: { ...phase } });
    this.emit('usage', s.usage);
    this.save();
  }

  /* ---------- 收尾：裁判 + 报告 ---------- */

  async conclude() {
    const s = this.session;
    const cfg = s.config;
    s.status = 'finished';
    this.emit('state', { status: 'finished' });
    this.log('全部环节结束，开始裁判与复盘…');
    this.save();

    if (cfg.judgeEnabled) {
      try {
        const taskText = buildJudgeTask(s, cfg);
        const messages = buildMessages({ session: s, config: cfg, taskText });
        this.emit('judging', { kind: 'judge' });
        const res = await streamChat({
          apiKey: getApiKey(),
          baseUrl: cfg.baseUrl,
          model: cfg.model?.includes('reasoner') ? cfg.model : 'deepseek-reasoner',
          messages,
          maxTokens: 1600,
          onDelta: (d) => this.emit('judge_delta', { kind: d.type, text: d.text }),
        });
        s.judge = res.content;
        accUsage(s, res.usage, 'deepseek-reasoner');
        this.emit('judge_done', { judge: s.judge });
        this.emit('usage', s.usage);
        this.save();
      } catch (e) {
        this.log(`裁判生成失败：${e.message}`, 'warn');
      }
    }

    if (cfg.autoReport) {
      try {
        await this.generateReport();
      } catch (e) {
        this.log(`报告生成失败：${e.message}`, 'warn');
      }
    }

    this.emit('state', { status: 'finished' });
    this.save();
  }

  async generateReport() {
    const s = this.session;
    const cfg = s.config;
    const taskText = buildReportTask(s, cfg, s.judge || '（无裁判意见）');
    const messages = buildMessages({ session: s, config: cfg, taskText });
    this.emit('judging', { kind: 'report' });
    const res = await streamChat({
      apiKey: getApiKey(),
      baseUrl: cfg.baseUrl,
      model: cfg.model?.includes('reasoner') ? cfg.model : 'deepseek-chat',
      messages,
      maxTokens: 4000,
      onDelta: (d) => this.emit('report_delta', { kind: d.type, text: d.text }),
    });
    accUsage(s, res.usage, 'deepseek-chat');
    const md = this.composeReport(res.content);
    s.report = md;
    s.reportFile = saveReport(s.id, md);
    this.emit('report_done', { report: md, file: s.reportFile });
    this.emit('usage', s.usage);
    this.save();
    return md;
  }

  /** 在 AI 报告前后补上机器生成的元信息与来源清单，保证出处可核查 */
  composeReport(aiBody) {
    const s = this.session;
    const cfg = s.config;
    const totalWords = s.turns.reduce((a, t) => a + (t.words || 0), 0);
    const header = [
      `# 辩论复盘报告`,
      ``,
      `> **辩题**：${cfg.topic}`,
      `> **正方**：${cfg.proStance}`,
      `> **反方**：${cfg.conStance}`,
      `> **赛制**：4v4（立论 / 驳论 / 攻辩质询 / 自由辩论 ${cfg.rounds} 轮 / 总结陈词）`,
      `> **模型**：${cfg.model}｜思考强度：${cfg.reasoningEffort}`,
      `> **时间**：${new Date(s.createdAt).toLocaleString('zh-CN')}`,
      `> **数据**：共 ${s.turns.length} 次发言，${totalWords} 字；累计 ${s.usage.totalTokens} tokens，缓存命中率 ${(s.usage.cacheHitRate * 100).toFixed(1)}%，估算成本 ¥${s.usage.costEstimate.toFixed(4)}`,
      ``,
      `---`,
      ``,
    ].join('\n');

    const sources = collectSources(s);
    const sourceBlock = [
      ``,
      `---`,
      ``,
      `## 附：本场引用来源清单（机器汇总，可逐条核查）`,
      ``,
      ...(sources.length
        ? sources.map((x, i) => `${i + 1}. ${x.title}${x.site ? ` — ${x.site}` : ''}${x.url ? `\n   ${x.url}` : ''}`)
        : ['（本场未检索到可核查的外部来源）']),
      ``,
    ].join('\n');

    const footer = [
      ``,
      `---`,
      ``,
      `*本报告由 AI 辩论室自动生成。辩手发言中的具体数字请以上述来源原文为准；本报告不作为学术引用依据。*`,
    ].join('\n');

    return `${header}${aiBody}${sourceBlock}${footer}`;
  }
}

export function collectSources(session) {
  const map = new Map();
  for (const side of ['pro', 'con']) {
    for (const c of session.research?.[side] || []) {
      if (c.url && !map.has(c.url)) {
        let site = c.site;
        if (!site) { try { site = new URL(c.url).hostname.replace(/^www\./, ''); } catch {} }
        map.set(c.url, { title: c.title || c.url, url: c.url, site });
      }
    }
  }
  const urlRe = /https?:\/\/[^\s)\]）】"'，。；]+/g;
  for (const t of session.turns || []) {
    for (const u of (t.content || '').match(urlRe) || []) {
      if (!map.has(u)) {
        let site = '';
        try { site = new URL(u).hostname.replace(/^www\./, ''); } catch {}
        map.set(u, { title: site || u, url: u, site });
      }
    }
  }
  return [...map.values()];
}

/* ---------------- 对外 API ---------------- */

export function getRunner(id) {
  return runners.get(id);
}

export function startRunner(session, emit) {
  const existing = runners.get(session.id);
  if (existing && !existing.aborted && (session.status === 'running' || session.status === 'researching')) {
    return existing;
  }
  const runner = new Runner(session, emit);
  runners.set(session.id, runner);
  runner.run();
  return runner;
}

export function controlSession(session, action, payload, emit) {
  const runner = runners.get(session.id);
  switch (action) {
    case 'start': {
      if (session.status === 'finished') return { ok: false, message: '本场已结束，请新建一场' };
      if (!runner || runner.aborted) return { ok: true, runner: startRunner(session, emit) };
      runner.resume();
      return { ok: true };
    }
    case 'pause':
      if (!runner) return { ok: false, message: '没有正在进行的辩论' };
      runner.pause();
      return { ok: true };
    case 'resume':
      if (!runner) return { ok: false, message: '没有正在进行的辩论' };
      runner.resume();
      return { ok: true };
    case 'step':
      if (!runner) return { ok: false, message: '没有正在进行的辩论' };
      runner.stepOnce = true;
      runner.resume();
      return { ok: true };
    case 'skip': {
      const phase = session.phases.find((p) => p.status === 'pending');
      if (phase) {
        phase.status = 'skipped';
        emit?.('phase', { phase: { ...phase } });
        saveSession(session);
      }
      return { ok: true };
    }
    case 'inject': {
      const note = String(payload?.note || '').trim();
      if (!note) return { ok: false, message: '提示内容为空' };
      session.interventionQueue.push(note.slice(0, 400));
      saveSession(session);
      emit?.('injected', { note });
      return { ok: true };
    }
    case 'stop':
      if (runner) runner.abort();
      session.status = 'finished';
      saveSession(session);
      emit?.('state', { status: 'finished' });
      return { ok: true };
    case 'rewind': {
      // 撤回最后一段发言，重新执行该环节
      if (runner && !runner.aborted) return { ok: false, message: '请先暂停再撤回' };
      const last = session.turns.pop();
      if (!last) return { ok: false, message: '没有可撤回的发言' };
      const phase = session.phases[last.phaseIndex];
      if (phase) { phase.status = 'pending'; delete phase.error; }
      session.status = 'paused';
      saveSession(session);
      emit?.('rewound', { phaseIndex: last.phaseIndex });
      return { ok: true };
    }
    case 'regenerate-report': {
      const r = new Runner(session, emit);
      r.generateReport().catch((e) => emit?.('error', { message: e.message }));
      return { ok: true };
    }
    default:
      return { ok: false, message: `未知操作：${action}` };
  }
}
