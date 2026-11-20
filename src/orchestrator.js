// 辩论调度器：标准四对四赛制状态机 + 可控执行 + 流式事件 + 缓存统计 + 跨场记忆
import { buildPhases, resolveModel, sideName, speakerLabel } from './config.js';
import { streamChat } from './deepseek.js';
import { search, fetchPageDigest } from './search.js';
import {
  buildMessages,
  buildBrief,
  buildTurnTask,
  buildResearchTask,
  buildJudgeTask,
  buildReportTask,
  buildReviewTask,
} from './prompts.js';
import {
  saveSession, saveReport, readMemory, appendMemory, getApiKey,
} from './store.js';

// 估算单价（元 / 百万 token）
const PRICING = {
  'deepseek-chat': { hit: 0.2, miss: 2.0, out: 3.0 },
  'deepseek-reasoner': { hit: 0.2, miss: 2.0, out: 3.0 },
};

const DELTA_FLUSH_MS = 70; // 流式合批：把逐 token 的增量合成一次推送，避免前端被刷爆
const TICK_MS = 900;

const runners = new Map();
let seriesHandler = null;

/** 由 server 注入：一场打完后自动开下一场（系列赛） */
export function setSeriesHandler(fn) {
  seriesHandler = fn;
}

export function emptyUsage() {
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
    savedEstimate: 0,
    last: null,
  };
}

function accUsage(session, usage, model, extra = {}) {
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
  // 若这些命中的 token 按未命中价计费，会多花多少
  u.savedEstimate = (u.cacheHitTokens / 1e6) * (p.miss - p.hit);
  const total = (usage.cacheHitTokens || 0) + (usage.cacheMissTokens || 0);
  u.last = {
    model,
    promptTokens: usage.promptTokens || 0,
    completionTokens: usage.completionTokens || 0,
    reasoningTokens: usage.reasoningTokens || 0,
    cacheHitTokens: usage.cacheHitTokens || 0,
    cacheMissTokens: usage.cacheMissTokens || 0,
    hitRate: total ? (usage.cacheHitTokens || 0) / total : 0,
    elapsedMs: extra.elapsedMs || 0,
    firstTokenMs: extra.firstTokenMs || 0,
    label: extra.label || '',
  };
}

/** 发言正文不该带 Markdown 记号：清掉标题、加粗、列表符 */
function cleanSpeech(text) {
  return String(text || '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\*\*/g, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(text) {
  return (text || '').replace(/\s/g, '').length;
}

/** 从发言里抽几条「论点」作为锚点（用于复盘与报告，不影响提示词前缀） */
function extractClaims(text, max = 4) {
  const paras = (text || '')
    .split(/\n+/)
    .map((s) => s.replace(/^[-·•\d①-⑨.、）)]+\s*/, '').trim())
    .filter((s) => s.length >= 12 && s.length <= 220);
  return paras.slice(0, max).map((s) => (s.length > 56 ? `${s.slice(0, 56)}…` : s));
}

/** 把跨场记忆压缩成一段，放进恒定简报 */
function memoryText(config, rounds) {
  const lines = [];
  for (const side of ['pro', 'con']) {
    for (const d of config.debaters?.[side] || []) {
      const m = readMemory(side, d.id);
      const notes = (m.matches || []).slice(-Math.max(1, rounds));
      if (!notes.length) continue;
      const latest = String(notes.at(-1).note || '').slice(0, 120);
      const earlier = notes.slice(0, -1).map((n) => String(n.note || '').slice(0, 40)).join('；');
      lines.push(
        `${speakerLabel(side, d.id)} ${d.name}｜最近一场：${latest}${earlier ? `｜更早：${earlier}` : ''}`
      );
    }
  }
  return lines.join('\n');
}

export function createSession(config, overrides = {}) {
  const merged = { ...config, ...overrides, debaters: config.debaters };
  const phases = buildPhases(merged);
  const total = Math.max(1, Math.min(20, Number(merged.seriesMatches) || 1));
  const session = {
    id: overrides.id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    topic: merged.topic,
    config: merged,
    phases,
    turns: [],
    research: { pro: [], con: [] },
    brief: '',
    status: 'idle',
    currentPhaseIndex: 0,
    judge: '',
    judgeStream: '',
    report: '',
    reportFile: '',
    interventionQueue: [],
    error: null,
    usage: emptyUsage(),
    series: { index: Number(overrides.seriesIndex) || 1, total },
    stats: { startedAt: 0, endedAt: 0 },
  };
  return session;
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
    this._ticker = null;
    this._buf = '';
    this._bufReasoning = '';
    this._flushTimer = null;
    this._liveStart = 0;
    this._saveTimer = null;
    this._busy = false;
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.session.status = 'paused';
    this.emit('state', { status: 'paused' });
    this.saveNow();
  }

  resume() {
    this.paused = false;
    if (this.session.status !== 'finished') this.session.status = 'running';
    this.emit('state', { status: this.session.status });
    this._waiters.splice(0).forEach((r) => r());
  }

  abort() {
    this.aborted = true;
    this.paused = false;
    this._waiters.splice(0).forEach((r) => r());
    try { this._ctrl?.abort(); } catch {}
    this._stopLive();
    this.session.live = null;
  }

  async gate() {
    if (this.aborted) return;
    if (!this.paused) return;
    this.emit('state', { status: 'paused' });
    await new Promise((resolve) => this._waiters.push(resolve));
  }

  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 400);
  }

  saveNow() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    try { saveSession(this.session); } catch (e) { console.error('保存失败', e.message); }
  }

  log(message, level = 'info') {
    this.emit('log', { level, message, at: Date.now() });
    console.log(`[${level}] ${message}`);
  }

  nextPhase() {
    return this.session.phases.find((p) => p.status === 'pending');
  }

  /* ---------- 主循环 ---------- */

  async run() {
    const s = this.session;
    s.status = 'running';
    s.error = null;
    s.stats = { startedAt: Date.now(), endedAt: 0 };
    this.emit('state', { status: 'running', session: { series: s.series } });
    this.saveNow();

    try {
      if (s.config.searchEnabled && !s.researchDone) {
        await this.research();
      }
      this.ensureBrief();

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
      } else if (this.aborted) {
        s.status = 'paused';
        this.emit('state', { status: 'paused' });
      }
    } catch (err) {
      if (this.aborted) {
        s.status = 'paused';
        this.emit('state', { status: 'paused' });
      } else {
        s.status = 'error';
        s.error = err.message;
        this.emit('error', { message: err.message, status: err.status || 0 });
        this.emit('state', { status: 'error' });
      }
    } finally {
      this._stopLive();
      this.saveNow();
    }
  }

  ensureBrief() {
    const s = this.session;
    if (s.brief) return;
    const cfg = s.config;
    const mem = cfg.memory?.enabled ? memoryText(cfg, cfg.memory.rounds || 4) : '';
    s.brief = buildBrief(s, cfg, mem);
    this.saveNow();
  }

  /* ---------- 资料检索 ---------- */

  async research() {
    const s = this.session;
    const cfg = s.config;
    this.emit('state', { status: 'researching' });
    this.log('开始检索权威资料…');

    let queries = [];
    try {
      const r = await streamChat({
        apiKey: getApiKey(),
        baseUrl: cfg.baseUrl,
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是辩论队的资料研究员，只输出检索式，每行一条，不要编号和解释。' },
          { role: 'user', content: buildResearchTask(s, cfg) },
        ],
        maxTokens: 300,
        temperature: 0.6,
        timeoutMs: 60000,
      });
      queries = r.content
        .split(/\n+/)
        .map((x) => x.replace(/^[\d.、\-*]\s*/, '').trim())
        .filter((x) => x.length >= 4 && x.length <= 40)
        .slice(0, cfg.searchQueries || 5);
      accUsage(s, r.usage, 'deepseek-chat', { label: '生成检索式' });
      this.emit('usage', s.usage);
    } catch (e) {
      this.log(`检索式生成失败，改用内置检索式：${e.message}`, 'warn');
    }

    if (!queries.length) {
      queries = [`${cfg.topic.slice(0, 24)} 研究`, '生成式人工智能 学生 认知 影响 研究'];
    }

    const proQueries = ['AI 辅助学习 批判性思维 提升 研究', '生成式AI 学习效果 元分析 学生'];
    const conQueries = ['AI 依赖 认知卸载 学习 风险', 'ChatGPT 使用 学生 思维能力 下降 研究'];

    const keys = { tavily: process.env.TAVILY_API_KEY, serper: process.env.SERPER_API_KEY };
    const doSearch = async (list, tag) => {
      const all = [];
      for (const q of list) {
        try {
          const rows = await search(q, {
            limit: cfg.searchPerQuery || 4,
            authorityDomains: cfg.authorityDomains,
            keys,
          });
          rows.forEach((r) => all.push({ ...r, query: q }));
          this.log(`[${tag}]「${q}」→ ${rows.length} 条`);
        } catch (e) {
          this.log(`检索「${q}」失败：${e.message}`, 'warn');
        }
        await new Promise((r) => setTimeout(r, 350));
      }
      return all;
    };

    const [generic, proOnly, conOnly] = await Promise.all([
      doSearch(queries, '通用'),
      doSearch(proQueries, '正方'),
      doSearch(conQueries, '反方'),
    ]);

    const pick = (pool, extra) => {
      const seen = new Set();
      return [...extra, ...pool]
        .filter((r) => {
          if (!r.url || seen.has(r.url)) return false;
          seen.add(r.url);
          return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
    };

    s.research.pro = pick(generic, proOnly);
    s.research.con = pick(generic, conOnly);
    s.researchDone = true;

    for (const side of ['pro', 'con']) {
      const cards = s.research[side].slice(0, cfg.fetchPages || 3);
      await Promise.all(
        cards.map(async (c) => {
          if (!c.url) return;
          const digest = await fetchPageDigest(c.url, 1200);
          if (digest) c.digest = digest;
        })
      );
      this.emit('research', { side, cards: s.research[side] });
    }

    this.log(`资料检索完成：正方 ${s.research.pro.length} 条，反方 ${s.research.con.length} 条`);
    this.saveNow();
    this.emit('state', { status: 'running' });
  }

  /* ---------- 实时事件 ---------- */

  _startLive(phase) {
    this._liveStart = Date.now();
    this._buf = '';
    this._bufReasoning = '';
    this._liveChars = { content: 0, reasoning: 0 };
    this.session.live = {
      phaseIndex: phase.index,
      speakerLabel: phase.speakerLabel,
      stage: phase.stage,
      startedAt: this._liveStart,
      content: '',
      reasoning: '',
      model: resolveModel(this.session.config),
      chars: 0,
    };
    this._ticker = setInterval(() => {
      if (this.session.live) this.session.live.elapsedMs = Date.now() - this._liveStart;
      this.emit('tick', {
        phaseIndex: phase.index,
        elapsedMs: Date.now() - this._liveStart,
        reasoningChars: this._liveChars.reasoning,
        contentChars: this._liveChars.content,
        stage: phase.stage,
        speakerLabel: phase.speakerLabel,
      });
    }, TICK_MS);
  }

  _stopLive() {
    if (this._ticker) { clearInterval(this._ticker); this._ticker = null; }
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this._flush();
  }

  _pushDelta(kind, text, phaseIndex) {
    const live = this.session.live;
    if (kind === 'reasoning') {
      this._bufReasoning += text;
      this._liveChars.reasoning += text.length;
      if (live) live.reasoning += text;
    } else {
      this._buf += text;
      this._liveChars.content += text.replace(/\s/g, '').length;
      if (live) {
        live.content += text;
        live.chars = this._liveChars.content;
      }
    }
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._flush();
    }, DELTA_FLUSH_MS);
  }

  _flush() {
    const phaseIndex = this.session.currentPhaseIndex;
    if (this._buf) {
      const text = this._buf;
      this._buf = '';
      this.emit('delta', { phaseIndex, kind: 'content', text });
    }
    if (this._bufReasoning) {
      const text = this._bufReasoning;
      this._bufReasoning = '';
      this.emit('delta', { phaseIndex, kind: 'reasoning', text });
    }
  }

  /* ---------- 离线演练（不调用 API，仅用于验证实时链路与界面） ---------- */
  async mockStream(phase, onDelta, signal) {
    const thinkText = `先判断这一轮要完成什么：${phase.stage}。对方最强的那一句是「用 AI 就等于把思考外包」，我要先把它拆成两个前提：一是使用方式，二是使用时长。只要有一处站不住，对面整条线就断了。资料库里那篇讲认知卸载的研究可以用，但必须限定在「无提示直接抄答案」的情形。`;
    const bodyText = `我方回应这一点。对方把工具使用直接等同于思考外包，这是偷换。第一，真正的认知卸载发生在「不问过程、只要答案」的时候，而有效的辅助学习要求先自己走一遍，再让 AI 指出错在哪一步，这个动作本身就是复盘。第二，撤走 AI 之后能不能复现，取决于有没有形成可迁移的检查清单，而不是有没有用过工具。第三，对方举的深夜刷题场景，问题出在没有截止时间和没有反馈，不在于有没有 AI。所以对方论证的是滥用会带来风险，不是我方主张不成立。`;
    for (let i = 0; i < thinkText.length; i += 12) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { status: -1 });
      onDelta({ type: 'reasoning', text: thinkText.slice(i, i + 12) });
      await new Promise((r) => setTimeout(r, 18));
    }
    const target = Math.max(120, Math.min(phase.words, 420));
    let content = '';
    const unit = Math.ceil(target / bodyText.length);
    while (content.length < target) {
      if (signal?.aborted) throw Object.assign(new Error('已取消'), { status: -1 });
      const piece = bodyText.slice(content.length % bodyText.length, (content.length % bodyText.length) + 22) || '。';
      content += piece;
      onDelta({ type: 'content', text: piece });
      await new Promise((r) => setTimeout(r, 26));
    }
    const promptTokens = 1200 + Math.round(Math.random() * 300);
    const hit = Math.round(promptTokens * 0.93);
    return {
      content,
      reasoning: thinkText,
      usage: {
        promptTokens,
        completionTokens: Math.round((content.length + thinkText.length) * 0.7),
        reasoningTokens: Math.round(thinkText.length * 0.7),
        totalTokens: promptTokens + Math.round((content.length + thinkText.length) * 0.7),
        cacheHitTokens: hit,
        cacheMissTokens: promptTokens - hit,
        cacheHitRate: hit / promptTokens,
      },
      model: 'mock',
      firstTokenMs: 300,
      elapsedMs: 3000,
    };
  }

  /* ---------- 单个环节 ---------- */

  async runPhase(phase) {
    const s = this.session;
    const cfg = s.config;
    const model = resolveModel(cfg);
    const me = cfg.debaters?.[phase.side]?.find((d) => d.id === phase.speaker);

    phase.status = 'running';
    phase.startedAt = Date.now();
    s.currentPhaseIndex = phase.index;
    this.emit('phase', { phase: { ...phase } });

    const intervention = s.interventionQueue.shift() || '';
    const memoryLine = cfg.memory?.enabled
      ? (() => {
          const m = readMemory(phase.side, phase.speaker);
          const last = (m.matches || []).at(-1);
          return last ? String(last.note || '').slice(0, 100) : '';
        })()
      : '';

    const taskText = buildTurnTask({ session: s, phase, config: cfg, memoryLine, intervention });
    const messages = buildMessages({ session: s, config: cfg, taskText });

    this.emit('turn_start', {
      phaseIndex: phase.index,
      order: s.turns.filter((t) => t.status === 'done').length + 1,
      title: phase.title,
      speakerLabel: phase.speakerLabel,
      persona: me?.name || '',
      stage: phase.stage,
      side: phase.side,
      speaker: phase.speaker,
      minutes: phase.minutes,
      words: phase.words,
      model,
      reasoning: model === 'deepseek-reasoner',
      promptTokens: null,
    });

    this._startLive(phase);
    const startedAt = Date.now();
    let content = '';
    let reasoning = '';
    let usage = null;
    let meta = {};

    this._ctrl = new AbortController();
    try {
      const onDelta = (d) => this._pushDelta(d.type, d.text, phase.index);
      const res = process.env.DEBATE_MOCK === '1'
        ? await this.mockStream(phase, onDelta, this._ctrl.signal)
        : await streamChat({
            apiKey: getApiKey(),
            baseUrl: cfg.baseUrl,
            model,
            messages,
            maxTokens: cfg.maxOutputTokens || 8192,
            temperature: cfg.temperature ?? 1.0,
            timeoutMs: cfg.requestTimeoutMs || 300000,
            signal: this._ctrl.signal,
            onDelta,
          });
      this._stopLive();
      content = res.content;
      reasoning = res.reasoning;
      usage = res.usage;
      meta = res;
    } catch (err) {
      this._stopLive();
      this.session.live = null;
      phase.status = this.aborted ? 'pending' : 'error';
      if (!this.aborted) phase.error = err.message;
      this.emit('phase', { phase: { ...phase } });
      if (!this.aborted) this.emit('turn_error', { phaseIndex: phase.index, message: err.message });
      this.saveNow();
      throw err;
    }

    const order = s.turns.filter((t) => t.status === 'done').length + 1;
    const turn = {
      order,
      phaseIndex: phase.index,
      phaseKey: phase.key,
      title: phase.title,
      speakerLabel: phase.speakerLabel,
      persona: me?.name || '',
      type: phase.type,
      stage: phase.stage,
      side: phase.side,
      speaker: phase.speaker,
      round: phase.round || null,
      minutes: phase.minutes,
      // 兼容旧字段
      role: phase.stage,
      speakerName: phase.speakerLabel,
      content: cleanSpeech(content),
      reasoning: reasoning && reasoning.trim() ? reasoning : '',
      status: 'done',
      words: countWords(content),
      wordTarget: phase.words,
      wordCap: Math.ceil(phase.words * 1.15),
      claims: extractClaims(content),
      intervention: intervention || undefined,
      usage: usage || null,
      model,
      elapsedMs: Date.now() - startedAt,
      firstTokenMs: meta.firstTokenMs || 0,
      startedAt,
      endedAt: Date.now(),
    };

    s.turns.push(turn);
    phase.status = 'done';
    phase.endedAt = Date.now();
    phase.actualWords = turn.words;
    s.live = null;
    accUsage(s, usage, model, { elapsedMs: turn.elapsedMs, firstTokenMs: turn.firstTokenMs, label: phase.speakerLabel });

    this.emit('turn_done', { turn });
    this.emit('phase', { phase: { ...phase } });
    this.emit('usage', s.usage);
    this.saveNow();
  }

  /* ---------- 收尾 ---------- */

  async conclude() {
    const s = this.session;
    const cfg = s.config;
    const model = resolveModel(cfg);
    s.status = 'judging';
    this.emit('state', { status: 'judging' });
    this.log('全部环节结束，裁判评议中…');
    this.saveNow();

    if (cfg.judgeEnabled) {
      try {
        this.emit('judging', { kind: 'judge' });
        const taskText = buildJudgeTask(s, cfg);
        const messages = buildMessages({ session: s, config: cfg, taskText });
        s.judgeStream = '';
        const res = await streamChat({
          apiKey: getApiKey(),
          baseUrl: cfg.baseUrl,
          model,
          messages,
          maxTokens: cfg.maxOutputTokens || 8192,
          temperature: 0.6,
          timeoutMs: cfg.requestTimeoutMs || 300000,
          onDelta: (d) => {
            if (d.type === 'content') {
              s.judgeStream = (s.judgeStream + d.text).slice(-4000);
              this.emit('judge_delta', { kind: 'content', text: d.text });
            }
          },
        });
        s.judge = (res.content || '').trim();
        s.judgeStream = '';
        accUsage(s, res.usage, model, { elapsedMs: res.elapsedMs, label: '裁判' });
        this.emit('judge_done', { judge: s.judge });
        this.emit('usage', s.usage);
        this.saveNow();
      } catch (e) {
        this.log(`裁判生成失败：${e.message}`, 'warn');
      }
    }

    if (cfg.autoReport) {
      try {
        await this.generateReport();
      } catch (e) {
        this.log(`报告生成失败：${e.message}`, 'warn');
        this.emit('report_error', { message: e.message });
      }
    }

    // 赛后复盘 → 写入跨场记忆（离线演练不写，避免污染真实记忆）
    if (cfg.memory?.enabled && process.env.DEBATE_MOCK !== '1') {
      try {
        await this.review();
      } catch (e) {
        this.log(`复盘记忆写入失败：${e.message}`, 'warn');
      }
    }

    s.status = 'finished';
    s.stats.endedAt = Date.now();
    this.emit('state', { status: 'finished' });
    this.emit('finished', {
      sessionId: s.id,
      usage: s.usage,
      series: s.series,
    });
    this.saveNow();

    // 系列赛：自动开下一场
    const { index, total } = s.series || {};
    if (index && total && index < total) {
      emit_next(s, index + 1, total);
    }
  }

  async generateReport() {
    const s = this.session;
    const cfg = s.config;
    const model = resolveModel(cfg);
    const taskText = buildReportTask(s, cfg, s.judge || '（无裁判意见）');
    const messages = buildMessages({ session: s, config: cfg, taskText });
    this.emit('judging', { kind: 'report' });
    const res = await streamChat({
      apiKey: getApiKey(),
      baseUrl: cfg.baseUrl,
      model,
      messages,
      maxTokens: 12000,
      temperature: 0.7,
      timeoutMs: cfg.requestTimeoutMs || 300000,
      onDelta: (d) => this.emit('report_delta', { kind: d.type, text: d.text }),
    });
    accUsage(s, res.usage, model, { elapsedMs: res.elapsedMs, label: '复盘报告' });
    const md = this.composeReport(res.content);
    s.report = md;
    s.reportFile = saveReport(s.id, md);
    this.emit('report_done', { report: md, file: s.reportFile });
    this.emit('usage', s.usage);
    this.saveNow();
    return md;
  }

  /** 八位辩手各自的迭代笔记，写入 data/memory */
  async review() {
    const s = this.session;
    const cfg = s.config;
    const model = resolveModel(cfg);
    const taskText = buildReviewTask(s, cfg);
    const messages = buildMessages({ session: s, config: cfg, taskText });
    this.emit('reviewing', {});
    const res = await streamChat({
      apiKey: getApiKey(),
      baseUrl: cfg.baseUrl,
      model,
      messages,
      maxTokens: 3000,
      temperature: 0.5,
      timeoutMs: 180000,
    });
    accUsage(s, res.usage, model, { elapsedMs: res.elapsedMs, label: '赛后复盘' });

    const keep = cfg.memory?.rounds || 4;
    const updated = [];
    for (const raw of String(res.content || '').split(/\n+/)) {
      const line = raw.trim().replace(/^[-*\d.、\s]+/, '');
      const m = line.match(/^(正|反)方([一二三四])辩\s*[｜|]\s*(.+)$/);
      if (!m) continue;
      const side = m[1] === '正' ? 'pro' : 'con';
      const id = ['一', '二', '三', '四'].indexOf(m[2]) + 1;
      const note = m[3].trim();
      if (!note) continue;
      const d = cfg.debaters?.[side]?.find((x) => x.id === id);
      appendMemory(side, id, d?.name || '', {
        sessionId: s.id,
        topic: cfg.topic,
        at: Date.now(),
        note: note.slice(0, 200),
      }, keep);
      updated.push({ key: `${side}-${id}`, label: speakerLabel(side, id), note: note.slice(0, 120) });
    }
    s.reviewNotes = updated;
    this.emit('review_done', { notes: updated });
    this.saveNow();
  }

  /** 报告头尾：机器生成的元信息与来源清单，保证出处可核查 */
  composeReport(aiBody) {
    const s = this.session;
    const cfg = s.config;
    const totalWords = s.turns.reduce((a, t) => a + (t.words || 0), 0);
    let body = String(aiBody || '').replace(/^\s*#\s*[^\n]*\n+/, '').trim();
    if (!/^##\s*一、/.test(body) && /##\s*二、/.test(body)) {
      body = `## 一、辩题与赛制\n\n（见文首信息）\n\n${body}`;
    }

    const header = [
      `# 辩论复盘报告`,
      ``,
      `> **辩题**：${cfg.topic}`,
      `> **正方**：${cfg.proStance}`,
      `> **反方**：${cfg.conStance}`,
      `> **赛制**：四对四标准赛制 · 立论 / 驳论 / 质询与应答 / 质询小结 / 自由辩论 ${cfg.rounds} 轮 / 总结`,
      `> **模型**：${resolveModel(cfg)}｜思考强度：${cfg.reasoningEffort}`,
      `> **时间**：${new Date(s.createdAt).toLocaleString('zh-CN')}`,
      `> **数据**：${s.turns.length} 次发言 / ${totalWords} 字；累计 ${s.usage.totalTokens} tokens；缓存命中 ${(s.usage.cacheHitRate * 100).toFixed(1)}%；估算成本 ¥${s.usage.costEstimate.toFixed(4)}`,
      ``,
      `---`,
      ``,
    ].join('\n');

    const sources = collectSources(s);
    const citations = collectCitations(s);
    const sourceBlock = [
      ``,
      `---`,
      ``,
      `## 附：本场引用来源清单（机器汇总，可逐条核查）`,
      ``,
      `### 可点击核查的检索来源`,
      ``,
      ...(sources.length
        ? sources.map((x, i) => `${i + 1}. ${x.title}${x.site ? ` — ${x.site}` : ''}\n   ${x.url}`)
        : ['（本场未检索到可核查的外部来源）']),
      ``,
      `### 辩手在实录中标注的文献（未附链接，需自行核对）`,
      ``,
      ...(citations.length ? citations.map((c, i) => `${i + 1}. ${c}`) : ['（无）']),
      ``,
    ].join('\n');

    const footer = `\n---\n\n*本报告由 AI 辩论室自动生成。辩手发言中的具体数字请以上述来源原文为准，不宜直接作为学术引用。*\n`;
    return `${header}${body}${sourceBlock}${footer}`;
  }
}

function emit_next(session, index, total) {
  if (!seriesHandler) return;
  try {
    seriesHandler({ config: session.config, index, total, fromId: session.id });
  } catch (e) {
    console.error('系列赛启动失败', e.message);
  }
}

/* ---------------- 来源汇总 ---------------- */

export function collectSources(session) {
  const map = new Map();
  for (const side of ['pro', 'con']) {
    for (const c of session.research?.[side] || []) {
      if (!c.url || (c.score || 0) < 3) continue;
      if (!map.has(c.url)) {
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

export function collectCitations(session) {
  const re = /[（(]([^（）()\n]{2,42}?)[，,]\s*(\d{4})[）)]/g;
  const map = new Map();
  for (const t of session.turns || []) {
    let m;
    while ((m = re.exec(t.content || ''))) {
      const name = m[1].trim();
      const year = m[2];
      if (!name || /^\d+$/.test(name)) continue;
      if (/^(约|第|共|每|如|即|例如|其中|所以|因此|但|而|从|到)/.test(name)) continue;
      const key = `${name}|${year}`;
      if (!map.has(key)) map.set(key, `${name}（${year}）`);
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
  if (existing && !existing.aborted) return existing;
  const runner = new Runner(session, emit);
  runners.set(session.id, runner);
  runner.run();
  return runner;
}

export function stopRunner(id) {
  const r = runners.get(id);
  if (r) r.abort();
  runners.delete(id);
}

export function controlSession(session, action, payload, emit) {
  const runner = runners.get(session.id);
  switch (action) {
    case 'start': {
      if (session.status === 'finished') return { ok: false, message: '本场已结束，请新建一场' };
      if (!runner || runner.aborted) return { ok: true, runner: startRunner(session, emit) };
      session.status = 'running';
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
      runner.paused = false;
      runner._waiters.splice(0).forEach((r) => r());
      return { ok: true };
    case 'skip': {
      if (!runner) return { ok: false, message: '没有正在进行的辩论' };
      // 跳过「下一个尚未开始」的环节；正在生成的那个不能跳
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
      session.interventionQueue.push(note.slice(0, 300));
      saveSession(session);
      emit?.('injected', { note });
      return { ok: true };
    }
    case 'stop':
      if (runner) runner.abort();
      session.status = 'finished';
      session.stats = { ...(session.stats || {}), endedAt: Date.now() };
      saveSession(session);
      emit?.('state', { status: 'finished' });
      return { ok: true };
    case 'rewind': {
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
    case 'conclude': {
      const r = new Runner(session, emit);
      r.conclude().catch((e) => emit?.('error', { message: e.message }));
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
