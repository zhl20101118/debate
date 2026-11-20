// 完整实录导出：把一场辩论的全部输出（含思考过程）落成可读的 Markdown
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_DIR } from './paths.js';
import { collectSources, collectCitations } from './orchestrator.js';
import { resolveModel } from './config.js';

function clock(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function renderFullExport(session) {
  const cfg = session.config;
  const out = [];
  out.push(`# 辩论全程实录`);
  out.push('');
  out.push(`> **辩题**：${cfg.topic}`);
  out.push(`> **正方**：${cfg.proStance}`);
  out.push(`> **反方**：${cfg.conStance}`);
  out.push(`> **赛制**：四对四标准赛制，共 ${session.phases.length} 个环节`);
  out.push(`> **模型**：${resolveModel(cfg)}｜思考强度：${cfg.reasoningEffort}`);
  out.push(`> **时间**：${new Date(session.createdAt).toLocaleString('zh-CN')}`);
  out.push('');
  out.push('---');
  out.push('');
  out.push('## 环节表');
  out.push('');
  out.push('| # | 环节 | 时长 | 目标字数 | 实际字数 | 状态 |');
  out.push('|---|---|---|---|---|---|');
  for (const p of session.phases) {
    out.push(`| ${p.index + 1} | ${p.title} | ${clock(p.seconds * 1000)} | ${p.words} | ${p.actualWords || '—'} | ${p.status} |`);
  }
  out.push('');

  if (session.research?.pro?.length || session.research?.con?.length) {
    out.push('## 资料库');
    out.push('');
    for (const side of ['pro', 'con']) {
      const cards = session.research?.[side] || [];
      out.push(`### ${side === 'pro' ? '正方' : '反方'}检索结果（${cards.length}）`);
      out.push('');
      cards.forEach((c, i) => {
        out.push(`${i + 1}. 《${c.title}》${c.site ? ` — ${c.site}` : ''}`);
        if (c.url) out.push(`   ${c.url}`);
        if (c.digest || c.snippet) out.push(`   > ${String(c.digest || c.snippet).replace(/\s+/g, ' ').slice(0, 200)}`);
      });
      out.push('');
    }
  }

  out.push('## 全程发言');
  out.push('');
  for (const t of session.turns || []) {
    if (t.status !== 'done') continue;
    const head = `### 第 ${t.order} 回合 · ${t.speakerLabel || t.speakerName || ''} · ${t.stage || t.type || ''}`;
    out.push(head);
    out.push('');
    const meta = [];
    if (t.minutes) meta.push(`限时 ${clock(t.minutes * 60000)}`);
    meta.push(`${t.words} 字 / 目标 ${t.wordTarget || '—'}`);
    if (t.elapsedMs) meta.push(`生成耗时 ${clock(t.elapsedMs)}`);
    if (t.model) meta.push(t.model);
    if (t.usage) {
      const hit = (t.usage.cacheHitRate ?? 0) * 100;
      meta.push(`prompt ${t.usage.promptTokens} tok（命中 ${hit.toFixed(1)}%）`);
    }
    out.push(`*${meta.join('｜')}*`);
    out.push('');
    out.push(String(t.content || '').trim());
    out.push('');
    if (t.reasoning) {
      out.push('<details><summary>思考过程（' + t.reasoning.length + ' 字）</summary>');
      out.push('');
      out.push(String(t.reasoning).trim());
      out.push('');
      out.push('</details>');
      out.push('');
    }
  }

  if (session.judge) {
    out.push('## 裁判裁定');
    out.push('');
    out.push(String(session.judge).trim());
    out.push('');
  }

  if (session.reviewNotes?.length) {
    out.push('## 赛后记忆（已写入下一场的经验）');
    out.push('');
    for (const n of session.reviewNotes) out.push(`- **${n.label}**：${n.note}`);
    out.push('');
  }

  out.push('## 用量');
  out.push('');
  const u = session.usage || {};
  out.push(`- 调用次数：${u.calls || 0}`);
  out.push(`- prompt tokens：${u.promptTokens || 0}（命中 ${u.cacheHitTokens || 0} / 未命中 ${u.cacheMissTokens || 0}）`);
  out.push(`- completion tokens：${u.completionTokens || 0}（其中思考 ${u.reasoningTokens || 0}）`);
  out.push(`- 累计缓存命中率：${((u.cacheHitRate || 0) * 100).toFixed(2)}%`);
  out.push(`- 估算成本：¥${(u.costEstimate || 0).toFixed(4)}（因缓存节省 ¥${(u.savedEstimate || 0).toFixed(4)}）`);
  out.push('');

  const sources = collectSources(session);
  if (sources.length) {
    out.push('## 来源清单');
    out.push('');
    sources.forEach((s, i) => out.push(`${i + 1}. ${s.title}${s.site ? ` — ${s.site}` : ''}${s.url ? `\n   ${s.url}` : ''}`));
    out.push('');
  }
  const cites = collectCitations(session);
  if (cites.length) {
    out.push('## 发言中标注的文献');
    out.push('');
    cites.forEach((c, i) => out.push(`${i + 1}. ${c}`));
    out.push('');
  }

  return out.join('\n');
}

export function saveExport(session) {
  const md = renderFullExport(session);
  const file = path.join(EXPORT_DIR, `${session.id}-full.md`);
  fs.writeFileSync(file, md, 'utf8');
  return { file, md };
}
