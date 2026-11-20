/* AI 辩论室 · 前端（原生 JS，零依赖） */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const STATIC_MODE = new URLSearchParams(location.search).has('static'); // 静态快照模式（截图/低配设备）

const state = {
  session: null,
  stream: null,
  cfg: null,
  researchSide: 'pro',
  adminToken: localStorage.getItem('debate_admin_token') || '',
  follow: true,
  cards: new Map(), // phaseIndex -> refs
  phaseEls: new Map(),
  active: null, // 正在流式的卡片
  live: { startedAt: 0, timer: null, target: 0, phaseIndex: -1 },
  deltaQueue: { content: '', reasoning: '' },
  raf: 0,
  replay: false, // 正在看历史（非本场实时）
  spyLock: 0,
};

const STATUS_TEXT = {
  idle: '未开始',
  running: '进行中',
  researching: '检索资料',
  judging: '裁判评议',
  paused: '已暂停',
  finished: '已结束',
  error: '出错',
};

/* ---------------- 基础工具 ---------------- */

function toast(message, isErr = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

function fmtNum(n) {
  if (n == null) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function mmss(minutes) {
  const m = Math.floor(minutes || 0);
  const s = Math.round(((minutes || 0) % 1) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.adminToken) headers['x-admin-token'] = state.adminToken;
  const res = await fetch(path, { ...opts, headers });
  let json = {};
  try { json = await res.json(); } catch {}
  if (res.status === 403) {
    const t = prompt('需要管理口令（启动服务时 ADMIN_TOKEN 设置的值）：');
    if (t) {
      state.adminToken = t;
      localStorage.setItem('debate_admin_token', t);
      return api(path, opts);
    }
    throw new Error('未授权');
  }
  if (!res.ok || json.ok === false) throw new Error(json.message || `请求失败 ${res.status}`);
  return json;
}

/* ---------------- Markdown ---------------- */

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text) {
  let t = escapeHtml(text);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  t = t.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (m, p, u) =>
    `${p}<a href="${u}" target="_blank" rel="noreferrer">${u}</a>`);
  return t;
}

function renderMarkdown(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let inCode = false;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^```/.test(line)) {
      if (inCode) { out.push('</code></pre>'); inCode = false; }
      else { closeList(); out.push('<pre><code>'); inCode = true; }
      continue;
    }
    if (inCode) { out.push(escapeHtml(raw)); continue; }
    if (!line.trim()) { closeList(); continue; }
    if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr/>'); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }

    const q = line.match(/^>\s?(.*)$/);
    if (q) { closeList(); out.push(`<blockquote>${inline(q[1])}</blockquote>`); continue; }

    const ol = line.match(/^\s*(\d+)[.、)]\s+(.*)$/);
    const ul = line.match(/^\s*[-*·]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }
    if (ul) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

/* ---------------- 控制条 / 状态 ---------------- */

function setStatus(status) {
  const pill = $('#statusPill');
  pill.className = `status-pill ${status || 'idle'}`;
  pill.querySelector('span').textContent = STATUS_TEXT[status] || status || '未开始';

  const running = status === 'running' || status === 'researching' || status === 'judging';
  const s = state.session;
  const paused = status === 'paused';
  const idle = status === 'idle' || !s;
  const finished = status === 'finished';

  $('#btnStart').textContent = paused ? '▶ 继续' : running ? '▶ 进行中' : finished ? '▶ 已结束' : '▶ 开始辩论';
  $('#btnStart').disabled = running || finished;
  $('#btnPause').disabled = !running;
  $('#btnStep').disabled = running || finished || idle;
  $('#btnSkip').disabled = !running;
  $('#btnRewind').disabled = running || idle || !(s?.turns?.length);
  $('#btnStop').disabled = idle || finished;
  $('#btnReport').disabled = !s?.report;

  const badge = $('#liveBadge');
  if (['running', 'researching', 'judging'].includes(status)) badge.className = 'live-badge on';
  else if (paused) badge.className = 'live-badge hold';
  else badge.className = 'live-badge';
  badge.textContent = { running: 'LIVE', researching: '检索', judging: '评议', paused: '已暂停', finished: '已结束', idle: '待机', error: '出错' }[status] || '待机';

  if (finished && s) {
    const words = (s.turns || []).reduce((a, t) => a + (t.words || 0), 0);
    const dur = (s.stats?.startedAt && s.stats?.endedAt) ? s.stats.endedAt - s.stats.startedAt : 0;
    $('#liveWho').innerHTML = `<b>全场已结束</b><span>${s.turns.length} 次发言 · ${words} 字${dur ? ` · 用时 ${clock(dur)}` : ''}</span>`;
    $('#liveMeta').textContent = `模型 ${s.config.model}｜思考强度 ${s.config.reasoningEffort}`;
    $('#livePeek').textContent = s.judge ? '裁判已裁定，可展开右侧裁定全文' : '报告与完整实录可在右上角导出';
    $('#liveTimer').textContent = dur ? clock(dur) : '';
    $('#liveTimer').style.display = dur ? '' : 'none';
    $('#liveChars').textContent = `${words} 字`;
    $('#liveThink').textContent = `${fmtNum(s.usage?.reasoningTokens || 0)} tok`;
    $('#barContent').style.width = '100%';
    $('#barThink').style.width = '100%';
    $('#liveCard').classList.remove('on');
  }
}

/* ---------------- 流程轴 ---------------- */

function renderPhases() {
  const s = state.session;
  if (!s) return;
  const list = $('#phaseList');
  list.innerHTML = '';
  state.phaseEls.clear();

  const done = s.phases.filter((p) => p.status === 'done').length;
  $('#phaseCounter').textContent = `${done}/${s.phases.length}`;

  s.phases.forEach((p) => {
    const el = document.createElement('button');
    el.className = `phase-item ${p.status || 'pending'}`;
    el.dataset.phase = p.index;
    el.type = 'button';
    const words = p.actualWords ? `${p.actualWords}字` : `${p.words}字`;
    const mins = p.minutes || (p.words || 0) / ((s.config?.wordsPerMinute) || 240);
    const round = p.round ? `<em>第${p.round}段</em>` : '';
    el.innerHTML = `
      <i class="dot"></i>
      <span class="p-idx">${p.index + 1}</span>
      <span class="p-title">${escapeHtml(p.speakerLabel || p.title || '')}${round}<small>${escapeHtml(p.stage || '')}</small></span>
      <span class="p-time">${mmss(mins)}</span>
      <span class="p-words">${words}</span>`;
    el.title = `${p.title}｜限时 ${mmss(mins)}｜目标 ${p.words} 字`;
    el.onclick = () => jumpToPhase(p.index);
    list.appendChild(el);
    state.phaseEls.set(p.index, el);
    if (p.status === 'running') setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
  });

  // 回看历史时（没有正在进行的环节）从第 1 条开始显示，方便从头点
  if (!s.phases.some((p) => p.status === 'running')) list.scrollTop = 0;

  const pct = s.phases.length ? (done / s.phases.length) * 100 : 0;
  $('#progressFill').style.width = `${pct}%`;
}

function jumpToPhase(index) {
  const card = state.cards.get(index);
  if (!card) return toast('这一段还没有内容');
  state.spyLock = Date.now() + 900;
  card.wrap.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.wrap.classList.add('flash');
  setTimeout(() => card.wrap.classList.remove('flash'), 1600);
  highlightPhase(index);
}

function highlightPhase(index) {
  for (const [i, el] of state.phaseEls) el.classList.toggle('current', i === index);
}

/* ---------------- 发言卡片 ---------------- */

function makeThinking(text, live = false) {
  const d = document.createElement('details');
  d.className = `thinking${live ? ' thinking-live' : ''}`;
  const len = (text || '').length;
  d.innerHTML = `<summary>
      <span class="spin"></span>
      <span class="th-label">${live ? '思考中' : '思考过程'}</span>
      <span class="th-count">${live ? '0 字' : `${len} 字`}</span>
      <span class="peek"></span>
    </summary>
    <div class="think-body"></div>`;
  const body = d.querySelector('.think-body');
  if (text) body.textContent = text;
  return d;
}

function cleanText(text) {
  return String(text || '').replace(/\*\*/g, '').replace(/^\s*#{1,6}\s*/gm, '');
}

function sideChar(side) {
  return side === 'pro' ? '正' : '反';
}

function makeTurnCard(t) {
  const wrap = document.createElement('article');
  wrap.className = `turn ${t.side}`;
  wrap.dataset.phase = t.phaseIndex;

  const head = document.createElement('div');
  head.className = 'turn-head';
  head.innerHTML = `
    <span class="avatar">${sideChar(t.side)}</span>
    <span class="who">${escapeHtml(t.speakerLabel || t.speakerName || '')}</span>
    ${t.persona ? `<span class="persona">${escapeHtml(t.persona)}</span>` : ''}
    <span class="stage-tag">${escapeHtml(t.stage || t.role || '')}${t.round ? ` · 第 ${t.round} 段` : ''}</span>`;
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'turn-body';

  let thinking = null;
  if (t.reasoning && t.reasoning.trim()) {
    thinking = makeThinking(t.reasoning);
    body.appendChild(thinking);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = cleanText(t.content);
  body.appendChild(bubble);

  const foot = document.createElement('div');
  foot.className = 'turn-foot';
  const bits = [];
  bits.push(`实际 ${t.words || 0} 字`);
  if (t.wordTarget) bits.push(`目标 ${t.wordTarget} 字`);
  if (t.elapsedMs) bits.push(`生成 ${clock(t.elapsedMs)}`);
  if (t.model) bits.push(t.model.replace('deepseek-', ''));
  if (t.usage) {
    const hit = (t.usage.cacheHitRate ?? 0) * 100;
    bits.push(`缓存 ${hit.toFixed(1)}%`);
    bits.push(`${fmtNum(t.usage.promptTokens)} tok`);
  }
  foot.textContent = bits.join(' · ');
  body.appendChild(foot);

  wrap.appendChild(body);

  const refs = { wrap, body, bubble, thinking, foot, t };
  state.cards.set(t.phaseIndex, refs);
  return wrap;
}

function makeLiveCard(info) {
  const wrap = document.createElement('article');
  wrap.className = `turn ${info.side}`;
  wrap.dataset.phase = info.phaseIndex;
  wrap.innerHTML = `
    <div class="turn-head">
      <span class="avatar">${sideChar(info.side)}</span>
      <span class="who">${escapeHtml(info.speakerLabel)}</span>
      ${info.persona ? `<span class="persona">${escapeHtml(info.persona)}</span>` : ''}
      <span class="stage-tag">${escapeHtml(info.stage)}</span>
      <span class="live-chip"><span class="speaking-dot"><span></span><span></span><span></span></span><em class="live-clock">00:00</em></span>
    </div>
    <div class="turn-body"></div>`;

  const body = wrap.querySelector('.turn-body');
  const thinking = makeThinking('', true);
  thinking.style.display = 'none';
  const bubble = document.createElement('div');
  bubble.className = 'bubble streaming';
  body.appendChild(thinking);
  body.appendChild(bubble);

  const refs = {
    wrap,
    body,
    bubble,
    thinking,
    thinkBody: thinking.querySelector('.think-body'),
    peek: thinking.querySelector('.peek'),
    thCount: thinking.querySelector('.th-count'),
    clockEl: wrap.querySelector('.live-clock'),
    live: true,
    reasoningLen: 0,
    chars: 0,
    target: info.words || 0,
  };
  state.cards.set(info.phaseIndex, refs);
  state.active = refs;
  return refs;
}

/* ---------------- 实时面板 ---------------- */

function startLivePanel(info) {
  stopLivePanel();
  state.live.startedAt = Date.now();
  state.live.target = info.words || 0;
  state.live.phaseIndex = info.phaseIndex;

  $('#liveWho').innerHTML = `<b>${escapeHtml(info.speakerLabel)}</b><span>${escapeHtml(info.stage)} · 目标 ${info.words} 字</span>`;
  $('#liveMeta').textContent = `${info.model}${info.reasoning ? ' · 深度思考' : ''}｜限时 ${mmss(info.minutes)}`;
  $('#barContent').style.width = '0%';
  $('#barThink').style.width = '0%';
  $('#liveChars').textContent = `0/${info.words || 0}`;
  $('#liveThink').textContent = '0 字';
  $('#livePeek').textContent = '';
  $('#liveCard').classList.add('on');

  state.live.timer = setInterval(() => {
    const el = Date.now() - state.live.startedAt;
    $('#liveTimer').textContent = clock(el);
    if (state.active) state.active.clockEl.textContent = clock(el);
  }, 200);
}

function stopLivePanel() {
  if (state.live.timer) clearInterval(state.live.timer);
  state.live.timer = null;
}

function updateLiveNumbers(contentChars, reasoningChars) {
  const target = state.live.target || 1;
  $('#barContent').style.width = `${Math.min(100, (contentChars / target) * 100)}%`;
  $('#liveChars').textContent = `${contentChars}/${state.live.target}`;
  const thinkPct = Math.min(100, (reasoningChars / Math.max(1800, target * 2.2)) * 100);
  $('#barThink').style.width = `${thinkPct}%`;
  $('#liveThink').textContent = `${fmtNum(reasoningChars)} 字`;
}

/* ---------------- 用量 / 资料 / 记忆 ---------------- */

function renderUsage(u) {
  if (!u) return;
  $('#totalTokens').textContent = fmtNum(u.totalTokens);
  $('#hitMiss').textContent = `${fmtNum(u.cacheHitTokens)} / ${fmtNum(u.cacheMissTokens)}`;
  $('#calls').textContent = u.calls || 0;
  $('#cost').textContent = `¥${(u.costEstimate || 0).toFixed(4)}`;
  const rate = u.cacheHitRate || 0;
  $('#hitRate').textContent = `${Math.round(rate * 100)}%`;
  const c = 2 * Math.PI * 52;
  const ring = $('#ringFg');
  ring.style.strokeDashoffset = String(c * (1 - rate));
  ring.style.stroke = rate >= 0.9 ? 'var(--ok)' : rate >= 0.6 ? 'var(--accent)' : 'var(--warn)';

  if (u.last) {
    const lr = Math.round((u.last.hitRate || 0) * 100);
    $('#lastHit').textContent = `上次 ${lr}% · ${fmtNum(u.last.promptTokens)} tok`;
    $('#lastHit').style.color = lr >= 90 ? 'var(--ok)' : lr >= 60 ? 'var(--text-2)' : 'var(--warn)';
  }
}

function renderResearch() {
  const s = state.session;
  if (!s) return;
  const cards = s.research?.[state.researchSide] || [];
  $('#proCount').textContent = s.research?.pro?.length || 0;
  $('#conCount').textContent = s.research?.con?.length || 0;
  const box = $('#researchList');
  if (!cards.length) {
    box.innerHTML = '<div class="muted small">尚未检索到资料</div>';
    return;
  }
  box.innerHTML = cards
    .map((c) => {
      let host = '';
      try { host = new URL(c.url).hostname.replace(/^www\./, ''); } catch {}
      const auth = (c.score || 0) >= 4 ? '<span class="r-auth">权威</span>' : '';
      return `<div class="research-item">
        <a href="${escapeHtml(c.url)}" target="_blank" rel="noreferrer">${escapeHtml(c.title || c.url)}${auth}</a>
        <span class="r-site">${escapeHtml(host)}</span>
      </div>`;
    })
    .join('');
}

function renderJudge(judge, stream) {
  if (!judge && !stream) return;
  $('#judgeCard').hidden = false;
  const text = (judge || stream || '').replace(/[#*>`]/g, '');
  $('#judgePreview').textContent = text.slice(0, 320);
}

function renderMemory(notes) {
  if (!notes?.length) return;
  $('#memoryCard').hidden = false;
  $('#memoryList').innerHTML = notes
    .map((n) => `<div class="memory-item"><b>${escapeHtml(n.label)}</b><span>${escapeHtml(n.note)}</span></div>`)
    .join('');
}

function sysMsg(text, kind = '') {
  const el = document.createElement('div');
  el.className = `sys-msg ${kind}`;
  el.textContent = text;
  return el;
}

/* ---------------- 滚动 ---------------- */

function maybeScroll(force = false) {
  const stream = $('#stream');
  const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 220;
  if (force || state.follow || nearBottom) {
    stream.scrollTop = stream.scrollHeight;
    state.follow = true;
  }
}

/* ---------------- 全量渲染 ---------------- */

function renderAll() {
  const s = state.session;
  if (!s) return;
  $('#topicText').textContent = s.topic;
  renderPhases();
  renderUsage(s.usage);
  renderResearch();
  setStatus(s.status);
  renderJudge(s.judge, s.judgeStream);
  renderMemory(s.reviewNotes);

  const stream = $('#stream');
  stream.innerHTML = '';
  state.cards.clear();
  state.active = null;

  const live1 = s.live;
  if (s.research?.pro?.length || s.research?.con?.length) {
    stream.appendChild(sysMsg(`资料检索完成 · 正方 ${s.research.pro.length} 条 / 反方 ${s.research.con.length} 条`));
  }

  for (const t of s.turns || []) {
    if (t.status !== 'done') continue;
    stream.appendChild(makeTurnCard(t));
  }

  // 服务端保留了正在生成的半成品 → 刷新/断线重连后不丢画面
  if (live1 && (live1.content || live1.reasoning)) {
    const phase = s.phases[live1.phaseIndex] || {};
    const refs = makeLiveCard({
      phaseIndex: live1.phaseIndex,
      side: phase.side || 'pro',
      speakerLabel: live1.speakerLabel || phase.speakerLabel || '',
      persona: phase.persona || '',
      stage: live1.stage || phase.stage || '',
      words: phase.words || 0,
      minutes: phase.minutes || 0,
    });
    refs.bubble.textContent = live1.content || '';
    refs.chars = (live1.content || '').replace(/\s/g, '').length;
    if (live1.reasoning) {
      refs.thinking.style.display = '';
      refs.thinkBody.textContent = live1.reasoning;
      refs.reasoningLen = live1.reasoning.length;
      refs.thCount.textContent = `${fmtNum(refs.reasoningLen)} 字`;
      refs.peek.textContent = tail(live1.reasoning, 60);
    }
    stream.appendChild(refs.wrap);
    startLivePanel({
      phaseIndex: live1.phaseIndex,
      speakerLabel: live1.speakerLabel || '',
      stage: live1.stage || '',
      words: phase.words || 0,
      minutes: phase.minutes || 0,
      model: live1.model || '',
      reasoning: true,
    });
    updateLiveNumbers(refs.chars, refs.reasoningLen);
  }

  if (!stream.children.length) {
    stream.innerHTML = `<div class="empty-state" id="emptyState">
        <div class="empty-icon">⚔️</div>
        <h2>辩论室已就绪</h2>
        <p>八位 AI 辩手已就位，各自带着不同的记忆与风格。<br/>点击「开始辩论」，或先在设置里改辩题与赛制。</p>
        <div class="empty-hint">资料检索 → 立论 → 驳论 → 质询与应答 → 质询小结 → 自由辩论 → 总结</div>
      </div>`;
  }

  state.spyLock = Date.now() + 900; // 初次渲染的自动滚动不触发联动，避免进度轴被拽到中段
  stream.scrollTop = stream.scrollHeight;
}

function tail(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/* ---------------- 流式增量（rAF 合批） ---------------- */

function queueDelta(kind, text) {
  state.deltaQueue[kind] += text;
  if (state.raf) return;
  state.raf = requestAnimationFrame(applyDeltas);
}

function applyDeltas() {
  state.raf = 0;
  const q = state.deltaQueue;
  const a = state.active;
  if (!a) { q.content = ''; q.reasoning = ''; return; }

  if (q.reasoning) {
    a.thinking.style.display = '';
    a.reasoningLen += q.reasoning.length;
    a.thinkBody.appendChild(document.createTextNode(q.reasoning));
    a.thCount.textContent = `${fmtNum(a.reasoningLen)} 字`;
    a.peek.textContent = tail(a.thinkBody.textContent, 70);
    const peek = $('#livePeek');
    if (peek) peek.textContent = tail(a.thinkBody.textContent, 120);
    q.reasoning = '';
  }
  if (q.content) {
    a.bubble.appendChild(document.createTextNode(q.content));
    a.chars += q.content.replace(/\s/g, '').length;
    q.content = '';
  }
  updateLiveNumbers(a.chars, a.reasoningLen);
  maybeScroll();
}

/* ---------------- SSE ---------------- */

function connect(id) {
  if (state.stream) state.stream.close();
  state.replay = false;
  const es = new EventSource(`/api/sessions/${id}/stream`);
  state.stream = es;

  es.addEventListener('snapshot', (e) => {
    const s = JSON.parse(e.data);
    state.session = s;
    renderAll();
  });

  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    if (!state.session) return;
    if (d.status) {
      state.session.status = d.status;
      setStatus(d.status);
      if (d.status === 'finished' || d.status === 'paused') stopLivePanel();
    }
  });

  es.addEventListener('phase', (e) => {
    const { phase } = JSON.parse(e.data);
    if (!state.session) return;
    state.session.phases[phase.index] = phase;
    const done = state.session.phases.filter((p) => p.status === 'done').length;
    $('#phaseCounter').textContent = `${done}/${state.session.phases.length}`;
    $('#progressFill').style.width = `${(done / state.session.phases.length) * 100}%`;
    const el = state.phaseEls.get(phase.index);
    if (el) {
      el.className = `phase-item ${phase.status}`;
      el.querySelector('.p-words').textContent = phase.actualWords ? `${phase.actualWords}字` : `${phase.words}字`;
      if (phase.status === 'running') el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });

  es.addEventListener('turn_start', (e) => {
    const d = JSON.parse(e.data);
    $('#emptyState')?.remove();
    $('#nowPlaying').innerHTML = `<b>${escapeHtml(d.speakerLabel)}</b><em>${escapeHtml(d.stage)} · 目标 ${d.words} 字</em>`;
    $('#nowPlaying').classList.add('active');

    const stream = $('#stream');
    const prev = state.cards.get(d.phaseIndex);
    if (prev?.wrap) prev.wrap.remove();
    const refs = makeLiveCard(d);
    stream.appendChild(refs.wrap);
    startLivePanel(d);
    highlightPhase(d.phaseIndex);
    state.follow = true;
    maybeScroll(true);
  });

  es.addEventListener('delta', (e) => {
    const d = JSON.parse(e.data);
    if (!state.active) return;
    if (d.phaseIndex != null && state.active.wrap?.dataset.phase != null &&
        String(d.phaseIndex) !== String(state.active.wrap.dataset.phase)) return;
    queueDelta(d.kind === 'reasoning' ? 'reasoning' : 'content', d.text);
  });

  es.addEventListener('tick', (e) => {
    const d = JSON.parse(e.data);
    if (!state.active) return;
    if (d.reasoningChars != null) {
      if (!state.active.reasoningLen) state.active.reasoningLen = d.reasoningChars;
    }
    if (d.contentChars != null && d.contentChars > state.active.chars) {
      // 服务端计数权威，用于校正本地累计（SSE 丢包时的兜底）
      state.active.chars = d.contentChars;
    }
    updateLiveNumbers(state.active.chars, d.reasoningChars || state.active.reasoningLen);
  });

  es.addEventListener('turn_done', (e) => {
    const { turn } = JSON.parse(e.data);
    if (!state.session) return;
    state.session.turns = (state.session.turns || []).filter((t) => t.phaseIndex !== turn.phaseIndex);
    state.session.turns.push(turn);
    state.session.turns.sort((a, b) => a.order - b.order);

    const a = state.active;
    if (a) {
      const el = makeTurnCard(turn);
      if (a.wrap?.parentNode) a.wrap.replaceWith(el);
      state.active = null;
    } else {
      $('#stream').appendChild(makeTurnCard(turn));
    }
    stopLivePanel();
    updateLiveNumbers(turn.words, (turn.reasoning || '').length);
    $('#liveBadge').textContent = '已完成';
    if (turn.intervention) $('#stream').appendChild(sysMsg(`主席提示：${turn.intervention}`));
    maybeScroll();
  });

  es.addEventListener('turn_error', (e) => {
    const d = JSON.parse(e.data);
    if (state.active) {
      state.active.bubble.classList.remove('streaming');
      state.active.bubble.textContent = '（本环节生成失败）';
      state.active = null;
    }
    stopLivePanel();
    $('#stream').appendChild(sysMsg(`生成失败：${d.message}`, 'err'));
    toast(d.message, true);
    maybeScroll();
  });

  es.addEventListener('usage', (e) => renderUsage(JSON.parse(e.data)));

  es.addEventListener('research', (e) => {
    const d = JSON.parse(e.data);
    if (!state.session) return;
    state.session.research[d.side] = d.cards;
    renderResearch();
  });

  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    if (d.level === 'warn') toast(d.message, true);
    else if (/检索|资料/.test(d.message)) {
      const stream = $('#stream');
      const last = stream.lastElementChild;
      if (last?.classList.contains('sys-msg') && /检索|资料/.test(last.textContent)) last.textContent = d.message;
      else { stream.appendChild(sysMsg(d.message)); maybeScroll(); }
    }
  });

  es.addEventListener('judging', (e) => {
    const d = JSON.parse(e.data);
    if (d.kind === 'judge') {
      $('#stream').appendChild(sysMsg('全场结束，裁判正在评议…'));
      $('#liveWho').innerHTML = '<b>裁判评议中</b><span>基于完整实录独立裁定</span>';
      $('#liveBadge').textContent = '评议';
    } else {
      $('#stream').appendChild(sysMsg('正在生成复盘报告…'));
      $('#liveWho').innerHTML = '<b>生成复盘报告</b><span>整理交锋与出处</span>';
    }
    maybeScroll();
  });

  es.addEventListener('judge_delta', (e) => {
    const d = JSON.parse(e.data);
    if (d.kind === 'content') {
      state.session.judgeStream = (state.session.judgeStream || '') + d.text;
      renderJudge('', state.session.judgeStream);
    }
  });

  es.addEventListener('judge_done', (e) => {
    const { judge } = JSON.parse(e.data);
    if (state.session) state.session.judge = judge;
    renderJudge(judge, '');
    stopLivePanel();
  });

  es.addEventListener('report_done', (e) => {
    const d = JSON.parse(e.data);
    if (state.session) state.session.report = d.report;
    $('#btnReport').disabled = false;
    $('#stream').appendChild(sysMsg('复盘报告已生成，点击右上角「报告」查看'));
    toast('辩论报告已生成');
    maybeScroll();
  });

  es.addEventListener('report_error', (e) => {
    toast(`报告生成失败：${JSON.parse(e.data).message}`, true);
  });

  es.addEventListener('reviewing', () => {
    $('#stream').appendChild(sysMsg('正在为八位辩手写赛后复盘，写入下一场记忆…'));
    maybeScroll();
  });

  es.addEventListener('review_done', (e) => {
    const d = JSON.parse(e.data);
    if (state.session) state.session.reviewNotes = d.notes || [];
    renderMemory(d.notes);
    toast('赛后记忆已写入');
  });

  es.addEventListener('injected', () => toast('已交给主席，将在下一位发言时生效'));

  es.addEventListener('navigate', (e) => {
    const d = JSON.parse(e.data);
    toast(`系列赛 第 ${d.index}/${d.total} 场开始`);
    location.hash = d.id;
    connect(d.id);
  });

  es.addEventListener('finished', () => {
    stopLivePanel();
    setStatus('finished');
    renderUsage(state.session?.usage);
  });

  es.addEventListener('error', (e) => {
    if (!e.data) return;
    const d = JSON.parse(e.data);
    toast(d.message, true);
    $('#stream').appendChild(sysMsg(`出错了：${d.message}`, 'err'));
    if (state.session) setStatus('error');
  });

  es.onerror = () => {
    // EventSource 会自动重连；重连后 snapshot 会补齐画面
    if (state.session && ['running', 'researching', 'judging'].includes(state.session.status)) {
      $('#liveBadge').textContent = '重连中';
    }
  };
}

/* ---------------- 控制 ---------------- */

async function control(action, payload = {}) {
  if (!state.session) return null;
  try {
    const r = await api(`/api/sessions/${state.session.id}/control`, {
      method: 'POST',
      body: JSON.stringify({ action, ...payload }),
    });
    if (r.ok === false) toast(r.message || '操作未执行', true);
    if (r.session) {
      state.session.status = r.session.status;
      setStatus(r.session.status);
      if (r.session.reviewNotes) renderMemory(r.session.reviewNotes);
    }
    return r;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

async function startDebate() {
  if (state.session && !['idle', 'finished'].includes(state.session.status)) return control('start');
  if (state.session && state.session.status === 'finished') {
    toast('本场已结束，请在设置里「新建一场」');
    return;
  }
  try {
    const r = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ autoStart: true }) });
    location.hash = r.id;
    $('#emptyState')?.remove();
    connect(r.id);
    toast('辩论开始');
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------- 设置 ---------------- */

function fillSettings(cfg) {
  $('#cfgTopic').value = cfg.topic;
  $('#cfgPro').value = cfg.proStance;
  $('#cfgCon').value = cfg.conStance;
  $('#cfgModel').value = cfg.model;
  $('#cfgEffort').value = cfg.reasoningEffort;
  $('#cfgRounds').value = cfg.rounds;
  $('#cfgWpm').value = cfg.wordsPerMinute;
  $('#cfgMinOpening').value = cfg.minutes.opening;
  $('#cfgMinRebuttal').value = cfg.minutes.rebuttal;
  $('#cfgMinCross').value = cfg.minutes.crossQ;
  $('#cfgMinCrossA').value = cfg.minutes.crossA;
  $('#cfgMinCrossS').value = cfg.minutes.crossSummary;
  $('#cfgMinFree').value = cfg.minutes.free;
  $('#cfgMinFinal').value = cfg.minutes.final;
  $('#cfgMemoryRounds').value = cfg.memory?.rounds ?? 4;
  $('#cfgSeries').value = cfg.seriesMatches ?? 4;
  $('#cfgSearch').checked = !!cfg.searchEnabled;
  $('#cfgMemory').checked = !!cfg.memory?.enabled;
  $('#cfgJudge').checked = !!cfg.judgeEnabled;
  $('#cfgAutoReport').checked = !!cfg.autoReport;
}

function collectSettings() {
  return {
    topic: $('#cfgTopic').value.trim(),
    proStance: $('#cfgPro').value.trim(),
    conStance: $('#cfgCon').value.trim(),
    model: $('#cfgModel').value,
    reasoningEffort: $('#cfgEffort').value,
    rounds: Number($('#cfgRounds').value) || 3,
    wordsPerMinute: Number($('#cfgWpm').value) || 240,
    minutes: {
      opening: Number($('#cfgMinOpening').value) || 3,
      rebuttal: Number($('#cfgMinRebuttal').value) || 2,
      crossQ: Number($('#cfgMinCross').value) || 1.5,
      crossA: Number($('#cfgMinCrossA').value) || 2,
      crossSummary: Number($('#cfgMinCrossS').value) || 1.5,
      free: Number($('#cfgMinFree').value) || 1,
      final: Number($('#cfgMinFinal').value) || 3.5,
    },
    memory: {
      enabled: $('#cfgMemory').checked,
      rounds: Number($('#cfgMemoryRounds').value) || 4,
    },
    seriesMatches: Number($('#cfgSeries').value) || 1,
    searchEnabled: $('#cfgSearch').checked,
    judgeEnabled: $('#cfgJudge').checked,
    autoReport: $('#cfgAutoReport').checked,
  };
}

async function saveSettings() {
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify(collectSettings()) });
    state.cfg = r.config;
    if (!state.session) $('#topicText').textContent = r.config.topic;
    toast('设置已保存');
    return r.config;
  } catch (e) {
    toast(e.message, true);
    return null;
  }
}

/* ---------------- 抽屉 / 弹窗 ---------------- */

function openDrawer(id) {
  $(id).classList.add('show');
  $('#drawerMask').classList.add('show');
}
function closeDrawers() {
  $$('.drawer').forEach((d) => d.classList.remove('show'));
  $('#drawerMask').classList.remove('show');
}

async function loadHistory() {
  try {
    const r = await api('/api/sessions');
    const box = $('#historyList');
    if (!r.sessions.length) {
      box.innerHTML = '<div class="muted small">还没有历史场次</div>';
      return;
    }
    box.innerHTML = r.sessions
      .map((s) => {
        const pct = Math.round((s.progressRatio || 0) * 100);
        return `<div class="history-item ${state.session?.id === s.id ? 'active' : ''}" data-id="${s.id}">
          <button class="h-del" data-del="${s.id}" title="删除">✕</button>
          <h4>${escapeHtml(s.topic)}</h4>
          <div class="h-bar"><i style="width:${pct}%"></i></div>
          <div class="h-meta">
            <span>${new Date(s.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            <span>${s.progress}</span>
            <span>${fmtNum(s.totalTokens)} tok</span>
            <span>缓存 ${Math.round((s.cacheHitRate || 0) * 100)}%</span>
            ${s.hasReport ? '<span class="h-dot">报告</span>' : ''}
          </div>
        </div>`;
      })
      .join('');
  } catch (e) {
    toast(e.message, true);
  }
}

async function openReport() {
  if (!state.session) return;
  try {
    const res = await fetch(`/api/sessions/${state.session.id}/report`);
    if (!res.ok) throw new Error('报告尚未生成');
    const md = await res.text();
    $('#reportTitle').textContent = '辩论复盘报告';
    $('#reportBody').innerHTML = renderMarkdown(md);
    $('#downloadReport').href = `/api/sessions/${state.session.id}/report?download=1`;
    $('#reportMask').classList.add('show');
  } catch (e) {
    toast(e.message, true);
  }
}

async function openExport() {
  if (!state.session) return toast('还没有场次', true);
  try {
    const res = await fetch(`/api/sessions/${state.session.id}/export`);
    const j = await res.json();
    if (!j.ok) throw new Error(j.message || '导出失败');
    $('#reportTitle').textContent = '全程实录（含思考过程）';
    $('#reportBody').innerHTML = renderMarkdown(j.markdown);
    $('#downloadReport').href = `/api/sessions/${state.session.id}/export?download=1`;
    $('#reportMask').classList.add('show');
    toast('已生成完整实录');
  } catch (e) {
    toast(e.message, true);
  }
}

/* ---------------- 初始化 ---------------- */

async function init() {
  try {
    const [cfgRes, keyRes] = await Promise.all([api('/api/config'), api('/api/secrets')]);
    state.cfg = cfgRes.config;
    fillSettings(cfgRes.config);
    $('#keyHint').textContent = keyRes.configured
      ? `已配置：${keyRes.masked}（来源：${keyRes.source === 'env' ? '环境变量' : '本地文件'}）`
      : '未配置 —— 必须先填 Key 才能开始';
  } catch (e) {
    toast(e.message, true);
  }

  $('#btnStart').onclick = startDebate;
  $('#btnPause').onclick = () => control('pause');
  $('#btnStep').onclick = () => control('step');
  $('#btnSkip').onclick = () => control('skip');
  $('#btnStop').onclick = () => { if (confirm('确定结束本场辩论？')) control('stop'); };
  $('#btnRewind').onclick = () => control('rewind');
  $('#btnReport').onclick = openReport;
  $('#btnExport').onclick = openExport;

  $('#btnInject').onclick = () => {
    $('#injectBar').classList.toggle('show');
    $('#injectInput').focus();
  };
  $('#injectCancel').onclick = () => $('#injectBar').classList.remove('show');
  $('#injectSend').onclick = async () => {
    const note = $('#injectInput').value.trim();
    if (!note) return;
    const r = await control('inject', { note });
    if (r) {
      $('#injectInput').value = '';
      $('#injectBar').classList.remove('show');
    }
  };
  $('#injectInput').onkeydown = (e) => { if (e.key === 'Enter') $('#injectSend').click(); };

  $('#btnSettings').onclick = () => openDrawer('#drawer');
  $('#drawerClose').onclick = closeDrawers;
  $('#drawerMask').onclick = closeDrawers;
  $('#saveCfg').onclick = saveSettings;

  $('#resetCfg').onclick = async () => {
    if (!confirm('恢复默认设置？')) return;
    const r = await api('/api/config/reset', { method: 'POST' });
    state.cfg = r.config;
    fillSettings(r.config);
    toast('已恢复默认');
  };

  $('#clearMemoryBtn').onclick = async () => {
    if (!confirm('清空所有跨场记忆？辩手会重新从零开始。')) return;
    await api('/api/memory', { method: 'DELETE' });
    toast('跨场记忆已清空');
    if (state.session) {
      state.session.reviewNotes = [];
      $('#memoryCard').hidden = true;
    }
  };

  $('#newDebate').onclick = async () => {
    await saveSettings();
    closeDrawers();
    if (state.stream) { state.stream.close(); state.stream = null; }
    state.session = null;
    state.cards.clear();
    history.replaceState(null, '', location.pathname);
    $('#stream').innerHTML = `<div class="empty-state" id="emptyState">
        <div class="empty-icon">⚔️</div>
        <h2>准备好了</h2>
        <p>新的一场辩论即将开始。<br/>点击上方「开始辩论」。</p>
      </div>`;
    setStatus('idle');
    $('#topicText').textContent = state.cfg.topic;
    $('#phaseList').innerHTML = '';
    $('#progressFill').style.width = '0%';
    $('#judgeCard').hidden = true;
    $('#memoryCard').hidden = true;
    toast('已按新设置准备就绪');
  };

  $('#saveKey').onclick = async () => {
    const key = $('#apiKeyInput').value.trim();
    if (!key) return toast('请先填入 Key', true);
    try {
      const r = await api('/api/secrets', { method: 'POST', body: JSON.stringify({ deepseekApiKey: key }) });
      $('#keyHint').textContent = `已配置：${r.masked}（来源：本地文件）`;
      $('#apiKeyInput').value = '';
      toast('Key 已保存到本地');
    } catch (e) {
      toast(e.message, true);
    }
  };

  $('#btnHistory').onclick = async () => { await loadHistory(); openDrawer('#historyDrawer'); };
  $('#historyClose').onclick = closeDrawers;

  $('#historyList').onclick = async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      if (!confirm('删除这场辩论及其报告？')) return;
      await api(`/api/sessions/${del.dataset.del}`, { method: 'DELETE' });
      await loadHistory();
      return;
    }
    const item = e.target.closest('.history-item');
    if (!item) return;
    closeDrawers();
    if (state.stream) state.stream.close();
    location.hash = item.dataset.id;
    connect(item.dataset.id);
  };

  $('#reportClose').onclick = () => $('#reportMask').classList.remove('show');
  $('#reportMask').onclick = (e) => { if (e.target.id === 'reportMask') $('#reportMask').classList.remove('show'); };

  $('#openJudge').onclick = () => {
    $('#reportTitle').textContent = '裁判裁定';
    $('#reportBody').innerHTML = renderMarkdown(state.session?.judge || '暂无裁判意见');
    $('#downloadReport').href = '#';
    $('#reportMask').classList.add('show');
  };

  $$('.tab').forEach((t) => {
    t.onclick = () => {
      $$('.tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      state.researchSide = t.dataset.side;
      renderResearch();
    };
  });

  // 用户上滑即停止自动跟随
  $('#stream').addEventListener('scroll', () => {
    const st = $('#stream');
    state.follow = st.scrollHeight - st.scrollTop - st.clientHeight < 160;
    // 滚动联动右侧流程轴
    if (Date.now() < state.spyLock) return;
    const top = st.scrollTop + 90;
    let best = -1;
    for (const [idx, refs] of state.cards) {
      if (refs.wrap.offsetTop <= top) best = idx;
    }
    if (best >= 0) {
      highlightPhase(best);
      const el = state.phaseEls.get(best);
      if (el && !state.session?.live) el.scrollIntoView({ block: 'nearest' });
    }
  });

  const id = location.hash.replace('#', '');
  if (id) {
    try {
      const r = await api(`/api/sessions/${id}`);
      state.session = r.session;
      if (STATIC_MODE) renderAll();
      else connect(id);
    } catch {
      toast('该场次不存在', true);
    }
  } else {
    setStatus('idle');
    if (state.cfg) $('#topicText').textContent = state.cfg.topic;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeDrawers();
    $('#reportMask').classList.remove('show');
    $('#injectBar').classList.remove('show');
  }
});

init();

