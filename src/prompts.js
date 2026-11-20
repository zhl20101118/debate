// 提示词构建 —— 结构围绕两件事：标准赛制 + DeepSeek 前缀缓存。
//
// 消息结构（每一轮都只在上一次的基础上「追加」，前缀永不改写）：
//   [0] system  全局规则            ← 整场恒定
//   [1] user    本场简报 BRIEF      ← 整场恒定（辩题/赛制/八人档案/资料库/跨场记忆）
//   [2] user    第 1 回合任务
//   [3] assistant 第 1 回合发言原文
//   [4] user    第 2 回合任务
//   ...
// 这样第 n 次调用请求的 messages 是第 n-1 次请求的严格超集，
// 命中的 token 单调增长，只有「上一段发言 + 本回合任务」是新增未命中。
// 八位辩手 / 裁判 / 报告 / 赛后复盘全部复用同一段前缀。

import { STAGE_LABEL, formatFlow, resolveModel, effortHint, speakerLabel, sideName } from './config.js';

/* 七类环节的写法要求：放进恒定简报，避免每轮重复计费 */
const STAGE_RULES = [
  ['立论', `用两句话点明本题真正的争夺点，并给出你方主张的评判标准（什么情况算提升了思考力）。然后给三个分论点，每个分论点后面必须跟一条真实论据或一个具体到人的场景。最后一句点明你方立场背后的价值，不要煽情。本轮对方尚未发言，不要预判式反驳。`],
  ['驳论', `第一句直接点名对方一辩立论中最致命的那个漏洞（是第几个分论点、错在哪）。然后用两到三层拆掉它：质疑论据来源与样本、指出被隐藏的前提、或推出对方不愿接受的荒谬结论。收尾用两三句加固你方被攻击的那一点，给出一层对方还没想到的新支撑。不要重复你方一辩的原话。`],
  ['质询', `向对方连续提 4 到 6 个封闭式问题，能用「是/否」或「哪一个」回答，禁止自问自答。问题必须递进：先问定义，再问边界，再问极端情形，最后一问要让对方承认一个与你方一致的前提。每问单独一行写成「问1：……」，最后用一句话说明这组问题想证明什么。问题要短，一问只打一个点。`],
  ['应答质询', `逐条回答对方的提问，格式为「问1：…… 答：……」，一个问题都不能漏。先给结论再给理由，每问答控制在 60 字内，不要展开成大段论证。可以拒答明显设套的问题，但要说清拒答理由，不能装没听见。全部答完后用一到两句反击，指出对方整组问题预设了错误前提。`],
  ['质询小结', `先算账：这一轮质询里对方哪一个问题始终没答、我方哪一个问题已经锁定。把你方拿到的那个承认，写成一条可以直接用的论据。指出对方应答中的自相矛盾，可引用原话片段。最后一句过渡到自由辩论，给出接下来要打的方向。不要重复立论，这一轮是收割。`],
  ['自由辩论', `第一句必须接住对方刚说过的具体那句话（可引用原话片段），不能换话题。第二句给出一层新的推进，或一个让对方难以两全的反问。全文 3 到 5 句短句，不要分段展开，不要重复队友刚说过的论据。拼的是反应速度，不是论证完整度。`],
  ['总结陈词', `归纳本场三个核心交锋点，每个一句话说清「争的是什么、我方为何占优、对方哪里没接住」。点出对方整场始终没有正面回答的那个问题，作为收官利器。最后把立场升华到价值层面：人的成长、教育的目的、这一代人的处境。要有感染力，但不要堆排比、不要喊口号。`],
];

const STAGE_NAME = {
  opening: '立论',
  rebuttal: '驳论',
  crossQ: '质询',
  crossA: '应答质询',
  crossSummary: '质询小结',
  free: '自由辩论',
  final: '总结陈词',
};
const STAGE_INDEX = Object.fromEntries(STAGE_RULES.map(([k], i) => [k, i + 1]));
function stageNo(phase) {
  return STAGE_INDEX[STAGE_NAME[phase.type]] || 1;
}

/* ================= 恒定部分 ================= */

export function buildGlobalSystem(config) {
  return `你是中文四对四辩论赛的职业辩手。整场只用简体中文，口语化、有对抗性、可直接念出来。

【铁律，违反即视为本轮失分】
1. 立场绝不摇摆。正方就把命题证成，反方就把命题证伪；禁止中立，禁止「双方都有道理」，禁止替对方补论证。
2. 只写发言本身。禁止「好的」「以下是」「作为 AI」「根据我的分析」这类开场白，禁止 Markdown 标题、加粗、代码块。
3. 引用必须真实可核查：优先使用【资料库】里的条目，句末用（机构，年份）标注。拿不准具体数字时只描述结论方向，绝不编造精确数字或假论文。
4. 严禁复述前文。同一论据最多深挖一次，再次出现必须换层次（从事实层换到机制层，或从机制层换到价值层）。
5. 点名接战。驳论、质询、自由辩论必须先咬住对方刚说过的具体那句话，再展开；不要自说自话。
6. 字数有硬上限，超出的部分裁判不计分。宁可少说一句有力的，也不要注水。
7. 不写舞台提示、不写括号动作、不写「（掌声）」。

【赛制】立论 → 驳论 → 质询与应答 → 质询小结 → 自由辩论 → 总结陈词。
【评判维度】论点成立度、论据可靠度、逻辑自洽度、回应有效性、价值说服力。`;
}

/** 本场简报：整场恒定，只构建一次并固化在 session.brief 上 */
export function buildBrief(session, config, memory) {
  const cfg = session.config || config;
  const model = resolveModel(cfg);
  const blocks = [];

  blocks.push(`【辩题】${cfg.topic}
【正方立场】${cfg.proStance}
【反方立场】${cfg.conStance}

【赛制（四对四标准赛制，共 ${Math.round(
    (session.phases || []).reduce((a, p) => a + p.minutes, 0)
  )} 分钟）】
${formatFlow(cfg)}

【关于「思考力」的共识边界】本场的思考力指：质疑与验证信息的能力、结构化拆解问题的能力、独立形成判断的能力、脱离辅助后迁移运用知识的能力。双方可以争夺这个定义，但不能偷换成记忆力、考试分数或工具熟练度。谁偷换定义，谁在裁判处失分。`);

  blocks.push(`【七种环节的写法要求（按顺序编号，本轮只执行编号对应的那一条）】
${STAGE_RULES.map(([name, text], i) => `${i + 1}. ${name}：${text}`).join('\n')}`);

  // 八人档案：全部放进恒定前缀，本轮只点名「谁出场」
  const lines = ['【八位辩手档案（同一场内的固定阵容）】'];
  for (const side of ['pro', 'con']) {
    for (const d of cfg.debaters?.[side] || []) {
      const label = speakerLabel(side, d.id);
      lines.push(
        `${label}｜${d.name}｜${d.style}｜长项：${d.strengths}｜语气：${d.tone}`
      );
    }
  }
  blocks.push(lines.join('\n'));

  // 资料库：双方共享，公开可引用
  const research = researchBlock(session);
  if (research) blocks.push(research);

  // 跨场记忆：同一批辩手打过多场后，带着经验上场
  if (memory) blocks.push(`【跨场经验（上几场留下的教训，必须体现，但不要说出来）】\n${memory}`);

  blocks.push(`【输出格式】直接给发言正文，按内容自然分段。不要写自己的名字，不要写「正方一辩：」，观众已经从界面知道是你。`);
  return blocks.join('\n\n');
}

function researchBlock(session) {
  const pro = session.research?.pro || [];
  const con = session.research?.con || [];
  if (!pro.length && !con.length) return '';
  const fmt = (c, i) => {
    const bits = [`${i + 1}. 《${trim(c.title, 70)}》`];
    const meta = [];
    if (c.site || c.url) meta.push(c.site || hostOf(c.url));
    if (c.year) meta.push(String(c.year));
    if (meta.length) bits.push(`— ${meta.join('，')}`);
    const digest = (c.digest || c.snippet || '').replace(/\s+/g, ' ').trim();
    if (digest) bits.push(`｜${trim(digest, 150)}`);
    if (c.url) bits.push(`｜${c.url}`);
    return bits.join(' ');
  };
  const out = ['【资料库 · 双方共享，引用时标注（机构，年份）】'];
  if (pro.length) {
    out.push('▸ 偏支持「提升」的条目：');
    pro.slice(0, 6).forEach((c, i) => out.push(fmt(c, i)));
  }
  if (con.length) {
    out.push('▸ 偏支持「降低」的条目：');
    con.slice(0, 6).forEach((c, i) => out.push(fmt(c, i)));
  }
  out.push('▸ 资料库里没有的内容，可以讲常识与生活场景，但不要伪装成研究结论。');
  return out.join('\n');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function trim(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/* ================= 历史对话 ================= */

/** 历史实录 → 标准的 user/assistant 对；只追加，不修改 */
export function buildHistory(session) {
  const out = [];
  const cfg = session.config;
  for (const t of session.turns || []) {
    if (t.status !== 'done' || !t.content) continue;
    const min = t.minutes ? `${Math.floor(t.minutes)}:${String(Math.round((t.minutes % 1) * 60)).padStart(2, '0')}` : '';
    const head = [`【第 ${t.order} 回合】${t.speakerLabel} · ${t.stage}${min ? `（${min}）` : ''}`];
    if (t.intervention) head.push(`【主席临时提示】${t.intervention}`);
    out.push({ role: 'user', content: head.join('\n') });
    out.push({ role: 'assistant', content: String(t.content).trim() });
  }
  return out;
}

/* ================= 本轮任务 ================= */


export function buildTurnTask({ session, phase, config, memoryLine, intervention }) {
  const cfg = session.config || config;
  const me = cfg.debaters?.[phase.side]?.find((d) => d.id === phase.speaker);
  const cap = Math.ceil(phase.words * 1.15);
  const blocks = [];

  blocks.push(
    `【本轮出场】${phase.speakerLabel}${me ? ` · ${me.name}` : ''} · ${phase.stage}（限时 ${Math.floor(
      phase.minutes
    )}:${String(Math.round((phase.minutes % 1) * 60)).padStart(2, '0')}，目标 ${phase.words} 字，硬上限 ${cap} 字）`
  );
  if (me) blocks.push(`【你的说话方式】${me.style}；${me.tone}`);
  blocks.push(
    `【本轮环节】按简报第 ${stageNo(phase)} 条「${STAGE_NAME[phase.type] || phase.stage}」的要求写。`
  );

  if (phase.type === 'free' && phase.round) {
    blocks.push(`【位置】自由辩论第 ${phase.round} 段，${sideName(phase.side)}发言。`);
  }
  if (phase.type === 'crossA') {
    blocks.push(`【对手】上一段是${sideName(phase.side === 'pro' ? 'con' : 'pro')}三辩的质询，逐条接住。`);
  }
  if (memoryLine) blocks.push(`【上一场留下的教训】${memoryLine}`);
  if (intervention) blocks.push(`【主席临时提示（必须回应）】${intervention}`);

  const hint = effortHint(cfg);
  if (hint) blocks.push(`【要求】${hint}`);

  blocks.push(`【字数】目标 ${phase.words} 字，不得超过 ${cap} 字。按真人 ${phase.minutes} 分钟语速折算，写超了裁判不计分。`);
  return blocks.join('\n\n');
}

/** 组合成完整 messages；当前任务永远在最后一条 */
export function buildMessages({ session, config, taskText }) {
  const cfg = session.config || config;
  const messages = [
    { role: 'system', content: buildGlobalSystem(cfg) },
    { role: 'user', content: session.brief || buildBrief(session, cfg) },
    ...buildHistory(session),
  ];
  if (taskText) messages.push({ role: 'user', content: taskText });
  return messages;
}

/* ================= 资料检索 ================= */

export function buildResearchTask(session, config) {
  const cfg = session.config || config;
  return `为下面这场辩论准备检索式。

辩题：${cfg.topic}
正方：${cfg.proStance}
反方：${cfg.conStance}

输出 ${cfg.searchQueries || 5} 条中文检索式，用于查找权威资料（学术论文、教育部门政策、认知科学与教育心理学研究、权威机构报告）。
要求：
1. 每条不超过 20 字，尽量带「研究」「报告」「数据」「元分析」等限定词；
2. 支持正方与支持反方各至少 2 条，其余找双方都会用到的中性事实；
3. 只输出检索式，每行一条，不要编号、不要解释。`;
}

/* ================= 裁判 ================= */

export function buildJudgeTask(session, config) {
  const cfg = session.config || config;
  return `【任务】你现在是本场辩论的独立裁判。请依据上面的完整实录作出裁定，不要偏袒任何一方。

辩题：${cfg.topic}
正方：${cfg.proStance}
反方：${cfg.conStance}

严格按下面的格式输出，不要增加其他章节：

## 裁定
胜方：正方 / 反方
比分：正方 X : Y 反方（百分制）
一句话理由：

## 三个决胜交锋点
1. 争点：……｜正方表现：……｜反方表现：……｜归属：……
2. 同上
3. 同上

## 双方最强与最弱
正方最强的一击：
正方最大的漏洞：
反方最强的一击：
反方最大的漏洞：

## 未被回答的问题
列出全场至少两个被提出、但始终没人正面回答的问题，注明是谁提出的。

## 谁更能说服真实听众
给出判断与理由，200 字以内。注意：论证自洽度与听众感染力是两件事，请分别评价。`;
}

/* ================= 报告 ================= */

export function buildReportTask(session, config, judgeText) {
  const cfg = session.config || config;
  return `【任务】把上面这场辩论整理成一份给人看的复盘报告，用 Markdown 输出。

硬性格式：
- 必须用 \`##\` 二级标题分六节，标题就叫「一、辩题与赛制」「二、双方论证骨架」「三、交锋复盘」「四、裁判结论」「五、资料出处」「六、给高中生的可操作建议」，一节都不能少；
- 总篇幅 2200–3200 字，宁可精炼，不要注水；不要开场白，不要「以上是报告」这类收尾。

各节要求：
- 一、辩题与赛制：说清辩题、双方立场、赛制与轮次、双方各自立的判准。
- 二、双方论证骨架：正反各 3-4 个论点，每个一句话概括 + 关键论据（带机构与年份）。
- 三、交锋复盘：按自由辩论逐轮写「攻方用了什么、守方怎么接、这一轮谁占上风」；质询与质询小结单独成段。要写具体的攻防，不要写「双方进行了激烈交锋」这种空话。
- 四、裁判结论：提炼下面的裁判意见（胜负、比分、三个决胜点），不要照抄全文。
- 五、资料出处：只整理实录与资料库里真实出现过的来源，格式《标题》— 机构/站点，有链接就写上。不得新增未出现过的来源。
- 六、给高中生的可操作建议：5 条，具体到行为（什么时候用、怎么问、什么时候必须停），不要空话。

裁判意见原文：
${judgeText || '（无）'}`;
}

/* ================= 赛后复盘（写入跨场记忆） ================= */

export function buildReviewTask(session, config) {
  const cfg = session.config || config;
  const roster = [];
  for (const side of ['pro', 'con']) {
    for (const d of cfg.debaters?.[side] || []) roster.push(`${speakerLabel(side, d.id)}｜${d.name}`);
  }
  return `【任务】你是这场辩论的复盘教练。为八位辩手各写一条「下场能直接用」的迭代笔记。

按下面的格式输出，每人一行，共八行，顺序与下面一致，不要写别的任何内容：

${roster.map((r) => `${r}｜保持：……｜改进：……｜下场第一句：……`).join('\n')}

要求：
- 每行总长不超过 90 字；
- 「保持」写他这场真正有效的做法（具体到某个动作，不要写「论证清晰」）；
- 「改进」写他被对方打穿或始终没回应的点；
- 「下场第一句」写成一句可以直接念出来的开场句，不要写建议。`;
}
