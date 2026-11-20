/* AI 辩论室 · 前端逻辑（原生 JS，零依赖） */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  session: null,
  stream: null,
  cfg: null,
  researchSide: 'pro',
  active: null, // 正在流式生成的气泡 { els, content, reasoning }
  adminToken: localStorage.getItem('debate_admin_token') || '',
  autoScroll: true,
  snapshotDone: false,
};

/* ---------------- 工具 ---------------- */

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
  return n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  let listType = null;
  let inCode = false;

  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
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
    if (h) {
      closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      continue;
    }

    const q = line.match(/^>\s?(.*)$/);
    if (q) {
      closeList();
      out.push(`<blockquote>${inline(q[1])}</blockquote>`);
      continue;
    }

    const ol = line.match(/^\s*(\d+)[.、)]\s+(.*)$/);
    const ul = line.match(/^\s*[-*·]\s+(.*)$/);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(ol[2])}</li>`);
      continue;
    }
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
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

/* ---------------- 状态渲染 ---------------- */

const STATUS_TEXT = {
  idle: '未开始',
  running: '进行中',
  researching: '检索资料',
  paused: '已暂停',
  finished: '已结束',
  error: '出错',
};

function setStatus(status) {
  const pill = $('#statusPill');
  pill.className = `status-pill ${status || 'idle'}`;
  pill.querySelector('span').textContent = STATUS_TEXT[status] || status;

  const running = status === 'running' || status === 'researching';
  $('#btnStart').disabled = running || status === 'finished';
  $('#btnPause').disabled = !running;
  $('#btnStep').disabled = !running && status !== 'paused';
  $('#btnSkip').disabled = running && status === 'researching';
  $('#btnStop').disabled = status === 'idle' || (status === 'finished' && !state.session?.turns?.length);
  $('#btnRewind').disabled = running || !(state.session?.turns?.length);
  $('#btnReport').disabled = !state.session?.report;
}

function renderPhases() {
  const s = state.session;
  if (!s) return;
  const list = $('#phaseList');
  list.innerHTML = '';
  const done = s.phases.filter((p) => p.status === 'done').length;
  $('#phaseCounter').textContent = `${done}/${s.phases.length}`;

  s.phases.forEach((p) => {
    const el = document.createElement('div');
    el.className = `phase-item ${p.status || 'pending'}`;
    if (p.status === 'running') el.classList.add('running');
    const mins = (p.words / (s.config.wordsPerMinute || 240)).toFixed(1);
    el.innerHTML = `<i class="dot"></i><span class="p-title">${escapeHtml(p.title)}</span><span class="p-time">${mins}′</span>`;
    list.appendChild(el);
    if (p.status === 'running') setTimeout(() => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  });

  const pct = s.phases.length ? (done / s.phases.length) * 100 : 0;
  $('#progressFill').style.width = `${pct}%`;
}

function renderUsage(u) {
  if (!u) return;
  $('#totalTokens').textContent = fmtNum(u.totalTokens);
  $('#hitMiss').textContent = `${fmtNum(u.cacheHitTokens)} / ${fmtNum(u.cacheMissTokens)}`;
  $('#calls').textContent = u.calls || 0;
  $('#cost').textContent = `¥${(u.costEstimate || 0).toFixed(4)}`;
  const rate = Math.round((u.cacheHitRate || 0) * 100);
  $('#hitRate').textContent = `${rate}%`;
  const c = 2 * Math.PI * 52;
  const ring = $('#ringFg');
  ring.style.strokeDashoffset = String(c * (1 - (u.cacheHitRate || 0)));
  ring.style.stroke = rate >= 70 ? 'var(--ok)' : rate >= 40 ? 'var(--accent)' : 'var(--warn)';
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

/* ---------------- 气泡 ---------------- */

function turnEl(turn, session) {
  const wrap = document.createElement('div');
  wrap.className = `turn ${turn.side}`;

  const phase = session?.phases?.[turn.phaseIndex];
  const isFree = turn.type === 'free';
  const roleText = phase ? phase.title.replace(/^(正方|反方)[一二三四]辩\s*·\s*/, '') : '';

  const head = document.createElement('div');
  head.className = 'turn-head';
  head.innerHTML = `
    <span class="avatar">${escapeHtml((turn.speakerName || '?').slice(0, 1))}</span>
    <span class="who">${escapeHtml(turn.speakerName || '')}</span>
    ${turn.role || roleText ? `<span class="role-tag">${escapeHtml(turn.role || roleText)}</span>` : ''}
    ${isFree && phase?.round ? `<span class="round-tag">第 ${phase.round} 轮</span>` : ''}
    <span class="stat-tag">${turn.words || 0} 字${turn.usage ? ` · ${Math.round((turn.usage.promptTokens + turn.usage.completionTokens) / 100) / 10}k tok` : ''}</span>
  `;
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'turn-body';

  if (turn.reasoning && turn.reasoning.trim()) {
    body.appendChild(makeThinking(turn.reasoning));
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = turn.content || '';
  body.appendChild(bubble);

  wrap.appendChild(body);
  return wrap;
}

function makeThinking(text, live = false) {
  const d = document.createElement('details');
  d.className = `thinking${live ? ' thinking-live' : ''}`;
  const chars = (text || '').length;
  d.innerHTML = `<summary>思考过程${live ? ' · 正在思考…' : ` · ${chars} 字`}</summary><div class="think-body"></div>`;
  d.querySelector('.think-body').textContent = text || '';
  return d;
}

function sysMsg(text, kind = '') {
  const el = document.createElement('div');
  el.className = `sys-msg ${kind}`;
  el.textContent = text;
  return el;
}

function maybeScroll() {
  const stream = $('#stream');
  const nearBottom = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 160;
  if (nearBottom || state.autoScroll) {
    stream.scrollTop = stream.scrollHeight;
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

  const stream = $('#stream');
  stream.innerHTML = '';
  state.active = null;

  if (s.research?.pro?.length || s.research?.con?.length) {
    stream.appendChild(sysMsg(`资料检索完成 · 正方 ${s.research.pro.length} 条 / 反方 ${s.research.con.length} 条`));
  }

  for (const t of s.turns || []) {
    stream.appendChild(turnEl(t, s));
  }

  if (s.judge) {
    $('#judgeCard').hidden = false;
    const plain = s.judge.replace(/[#*>`]/g, '').slice(0, 300);
    $('#judgePreview').textContent = plain;
  }
  if (s.report) $('#btnReport').disabled = false;

  stream.scrollTop = stream.scrollHeight;
}

/* ---------------- SSE ---------------- */

function connect(id) {
  if (state.stream) state.stream.close();
  state.snapshotDone = false;
  const es = new EventSource(`/api/sessions/${id}/stream`);
  state.stream = es;

  es.addEventListener('snapshot', (e) => {
    const s = JSON.parse(e.data);
    state.session = s;
    state.snapshotDone = true;
    renderAll();
  });

  es.addEventListener('state', (e) => {
    const d = JSON.parse(e.data);
    if (!state.session) return;
    if (d.status) {
      state.session.status = d.status;
      setStatus(d.status);
    }
    if (d.current) {
      $('#nowPlaying').textContent = d.current;
      $('#nowPlaying').classList.add('active');
    }
  });

  es.addEventListener('phase', (e) => {
    const { phase } = JSON.parse(e.data);
    if (!state.session) return;
    state.session.phases[phase.index] = phase;
    renderPhases();
  });

  es.addEventListener('turn_start', (e) => {
    const d = JSON.parse(e.data);
    const stream = $('#stream');
    const empty = $('#emptyState');
    if (empty) empty.remove();

    $('#nowPlaying').textContent = `正在发言：${d.title}`;
    $('#nowPlaying').classList.add('active');

    const wrap = document.createElement('div');
    wrap.className = `turn ${d.side}`;
    wrap.innerHTML = `
      <div class="turn-head">
        <span class="avatar">${escapeHtml((d.speakerName || '?').slice(0, 1))}</span>
        <span class="who">${escapeHtml(d.speakerName || '')}</span>
        <span class="role-tag">${escapeHtml(d.role || '')}</span>
        <span class="stat-tag">目标 ${d.words} 字<span class="speaking-dot"><span></span><span></span><span></span></span></span>
      </div>
      <div class="turn-body"></div>
    `;
    const body = wrap.querySelector('.turn-body');
    const thinking = makeThinking('', true);
    thinking.style.display = 'none';
    const bubble = document.createElement('div');
    bubble.className = 'bubble streaming';
    body.appendChild(thinking);
    body.appendChild(bubble);

    stream.appendChild(wrap);
    state.active = { wrap, body, thinking, bubble, content: '', reasoning: '', chars: 0 };
    maybeScroll();
  });

  es.addEventListener('delta', (e) => {
    const d = JSON.parse(e.data);
    const a = state.active;
    if (!a) return;
    if (d.kind === 'reasoning') {
      a.reasoning += d.text;
      a.thinking.style.display = '';
      a.thinking.querySelector('.think-body').textContent = a.reasoning;
      const sum = a.thinking.querySelector('summary');
      sum.textContent = `思考过程 · ${a.reasoning.length} 字`;
    } else {
      a.content += d.text;
      a.bubble.textContent = a.content;
      a.chars = a.content.replace(/\s/g, '').length;
      const tag = a.wrap.querySelector('.stat-tag');
      if (tag) tag.innerHTML = `${a.chars} 字<span class="speaking-dot"><span></span><span></span><span></span></span>`;
    }
    maybeScroll();
  });

  es.addEventListener('turn_done', (e) => {
    const { turn } = JSON.parse(e.data);
    if (!state.session) return;
    state.session.turns.push(turn);
    const a = state.active;
    if (a) {
      a.bubble.classList.remove('streaming');
      if (turn.reasoning) {
        a.thinking.classList.remove('thinking-live');
        const sum = a.thinking.querySelector('summary');
        sum.textContent = `思考过程 · ${turn.reasoning.length} 字`;
      } else {
        a.thinking.remove();
      }
      const tag = a.wrap.querySelector('.stat-tag');
      if (tag) {
        tag.textContent = `${turn.words} 字${turn.usage ? ` · ${Math.round((turn.usage.promptTokens + turn.usage.completionTokens) / 100) / 10}k tok` : ''}`;
      }
    }
    state.active = null;
    if (turn.intervention) {
      $('#stream').appendChild(sysMsg(`主席提示：${turn.intervention}`));
    }
  });

  es.addEventListener('turn_error', (e) => {
    const d = JSON.parse(e.data);
    if (state.active) {
      state.active.bubble.classList.remove('streaming');
      state.active.bubble.textContent = '（本环节生成失败）';
    }
    state.active = null;
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
      if (last?.classList.contains('sys-msg') && /检索|资料/.test(last.textContent)) {
        last.textContent = d.message;
      } else {
        stream.appendChild(sysMsg(d.message));
        maybeScroll();
      }
    }
  });

  es.addEventListener('judging', (e) => {
    const d = JSON.parse(e.data);
    $('#stream').appendChild(sysMsg(d.kind === 'judge' ? '全场结束，裁判正在评议…' : '正在生成复盘报告…'));
    maybeScroll();
  });

  es.addEventListener('judge_done', (e) => {
    const { judge } = JSON.parse(e.data);
    if (state.session) state.session.judge = judge;
    $('#judgeCard').hidden = false;
    $('#judgePreview').textContent = judge.replace(/[#*>`]/g, '').slice(0, 300);
  });

  es.addEventListener('report_done', (e) => {
    const d = JSON.parse(e.data);
    if (state.session) state.session.report = d.report;
    $('#btnReport').disabled = false;
    $('#stream').appendChild(sysMsg('复盘报告已生成，点击右上角「报告」查看'));
    toast('辩论报告已生成');
    maybeScroll();
  });

  es.addEventListener('injected', () => toast('已通知主席'));

  es.addEventListener('error', (e) => {
    if (!e.data) return;
    const d = JSON.parse(e.data);
    toast(d.message, true);
    $('#stream').appendChild(sysMsg(`出错了：${d.message}`, 'err'));
    if (state.session) setStatus('error');
  });

  es.onerror = () => {
    // EventSource 会自动重连，这里只做轻提示
  };
}

/* ---------------- 控制 ---------------- */

async function control(action, payload = {}) {
  if (!state.session) return;
  try {
    const r = await api(`/api/sessions/${state.session.id}/control`, {
      method: 'POST',
      body: JSON.stringify({ action, ...payload }),
    });
    if (r.session) {
      state.session.status = r.session.status;
      setStatus(r.session.status);
    }
  } catch (e) {
    toast(e.message, true);
  }
}

async function startDebate() {
  if (state.session && state.session.status !== 'idle') {
    return control('start');
  }
  try {
    const cfg = state.cfg || {};
    const r = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        autoStart: true,
        config: {
          topic: $('#cfgTopic')?.value || cfg.topic,
          proStance: $('#cfgPro')?.value || cfg.proStance,
          conStance: $('#cfgCon')?.value || cfg.conStance,
        },
      }),
    });
    history.replaceState(null, '', `#${r.id}`);
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
  $('#cfgMinFree').value = cfg.minutes.free;
  $('#cfgMinSummary').value = cfg.minutes.summary;
  $('#cfgSearch').checked = !!cfg.searchEnabled;
  $('#cfgConcise').checked = !!cfg.conciseContext;
  $('#cfgJudge').checked = !!cfg.judgeEnabled;
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
      crossA: 1,
      free: Number($('#cfgMinFree').value) || 0.7,
      summary: Number($('#cfgMinSummary').value) || 3.5,
    },
    searchEnabled: $('#cfgSearch').checked,
    conciseContext: $('#cfgConcise').checked,
    judgeEnabled: $('#cfgJudge').checked,
  };
}

async function saveSettings() {
  try {
    const r = await api('/api/config', { method: 'POST', body: JSON.stringify(collectSettings()) });
    state.cfg = r.config;
    if (state.session) $('#topicText').textContent = r.config.topic;
    toast('设置已保存');
  } catch (e) {
    toast(e.message, true);
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
      .map(
        (s) => `<div class="history-item ${state.session?.id === s.id ? 'active' : ''}" data-id="${s.id}">
          <button class="h-del" data-del="${s.id}" title="删除">✕</button>
          <h4>${escapeHtml(s.topic)}</h4>
          <div class="h-meta">
            <span>${new Date(s.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
            <span>进度 ${s.progress}</span>
            <span>${fmtNum(s.totalTokens)} tok</span>
            <span>缓存 ${Math.round((s.cacheHitRate || 0) * 100)}%</span>
          </div>
        </div>`
      )
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
    $('#reportBody').innerHTML = renderMarkdown(md);
    $('#downloadReport').href = `/api/sessions/${state.session.id}/report?download=1`;
    $('#reportMask').classList.add('show');
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

  // 绑定事件
  $('#btnStart').onclick = startDebate;
  $('#btnPause').onclick = () => control('pause');
  $('#btnStep').onclick = () => control('step');
  $('#btnSkip').onclick = () => control('skip');
  $('#btnStop').onclick = () => { if (confirm('确定结束本场辩论？')) control('stop'); };
  $('#btnRewind').onclick = () => control('rewind');
  $('#btnReport').onclick = openReport;

  $('#btnInject').onclick = () => {
    $('#injectBar').classList.toggle('show');
    $('#injectInput').focus();
  };
  $('#injectCancel').onclick = () => $('#injectBar').classList.remove('show');
  $('#injectSend').onclick = async () => {
    const note = $('#injectInput').value.trim();
    if (!note) return;
    await control('inject', { note });
    $('#injectInput').value = '';
    $('#injectBar').classList.remove('show');
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

  $('#newDebate').onclick = async () => {
    await saveSettings();
    closeDrawers();
    if (state.stream) { state.stream.close(); state.stream = null; }
    state.session = null;
    history.replaceState(null, '', location.pathname);
    $('#stream').innerHTML = `
      <div class="empty-state" id="emptyState">
        <div class="empty-icon">⚔️</div>
        <h2>准备好了</h2>
        <p>新的一场辩论即将开始。<br/>点击上方「开始辩论」。</p>
      </div>`;
    setStatus('idle');
    $('#topicText').textContent = state.cfg.topic;
    $('#phaseList').innerHTML = '';
    $('#progressFill').style.width = '0%';
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
    setStatus('paused');
  };

  $('#reportClose').onclick = () => $('#reportMask').classList.remove('show');
  $('#reportMask').onclick = (e) => { if (e.target.id === 'reportMask') $('#reportMask').classList.remove('show'); };

  $('#openJudge').onclick = () => {
    $('#reportBody').innerHTML = renderMarkdown(state.session?.judge || '暂无裁判意见');
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

  // 滚轮：用户上滑时不打断
  $('#stream').addEventListener('scroll', () => {
    const st = $('#stream');
    state.autoScroll = st.scrollHeight - st.scrollTop - st.clientHeight < 160;
  });

  // 载入 URL 指定的会话
  const id = location.hash.replace('#', '');
  if (id) {
    try {
      const r = await api(`/api/sessions/${id}`);
      state.session = r.session;
      if (r.session.status === 'running') setStatus('paused');
      connect(id);
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
