// 提示词构建 —— 全部围绕一件事：让 DeepSeek 的前缀缓存能命中。
//
// 结构固定为三条消息：
//   [0] system  : 全局规则（整场不变，纯固定文本）
//   [1] user    : 辩论实录（只追加、不修改，天然构成稳定前缀）
//   [2] user    : 本轮任务（唯一变化的部分，含角色人格）
// 所有辩手、裁判、报告都共用 [0] 和 [1]，差异只在 [2] 的尾巴上。

export function buildGlobalSystem(config) {
  return `你正在参与一场正式的中文四对四辩论赛，全程使用简体中文，以口语化但严谨的辩论腔发言。

【辩题】${config.topic}
【正方立场】${config.proStance}
【反方立场】${config.conStance}

【赛制】立论 → 驳论 → 攻辩质询 → 自由辩论 → 总结陈词。每位辩手只代表自己一方，依次出场。
【评判标准】论点是否成立、论据是否可靠可查、逻辑是否自洽、对对方攻击的回应是否有效、价值落点是否有说服力。

【铁律，违反即视为发言失败】
1. 立场绝不摇摆。你是正方就全力证成，是反方就全力证伪，不能替对方说话，不能中立，不能说"双方都有道理"。
2. 直接进入发言内容。禁止出现"好的""以下是""作为 AI""根据我的分析"这类开场白或元叙述。
3. 引用的研究、数据、机构、年份必须真实可核查。若拿不准具体数字，就描述研究结论的取向，不要编造精确数字。凡引用外部资料，在句末用（机构，年份）标注。
4. 不要大段重复前文。同一论据最多深挖一次，再次出现必须换角度或换层次。
5. 面向听众讲人话：短句为主，少用嵌套从句，少用"综上所述之逻辑推演"这类翻译腔。
6. 严格遵守字数要求，超出的部分会被裁判视为失分。

【关于「思考力」的共识边界】辩题中的思考力指：质疑与验证信息的能力、结构化拆解问题的能力、独立形成判断的能力、以及在无辅助条件下迁移运用知识的能力。双方可以争夺这个定义，但不能把它偷换成"记忆力""考试分数"或"使用工具熟练度"。`;
}

/** 把已完成发言渲染成实录。必须是确定性函数：同样的 turn 永远得到同样的文本。 */
export function renderTranscript(turns, config) {
  const done = (turns || []).filter((t) => t.status === 'done' && t.content);
  if (!done.length) return '【辩论实录】\n（尚未开始，你是第一位发言者）\n';
  const parts = ['【辩论实录】'];
  for (const t of done) {
    const sideName = t.side === 'pro' ? '正方' : '反方';
    const who = config.debaters?.[t.side]?.find((d) => d.id === t.speaker);
    const name = who ? `${who.name}（${sideName}${who.role}）` : `${sideName}${t.speaker}辩`;
    parts.push(`\n──── 第${t.order}位 · ${name} · ${t.title} ────`);
    parts.push(t.content.trim());
    if (t.intervention) parts.push(`（主席提示：${t.intervention}）`);
  }
  parts.push('\n──── 实录结束 ────');
  return parts.join('\n');
}

/** 汇总某一方已经说过的核心论点，帮助本方后续辩手不跑偏、对方辩手有的放矢 */
export function extractClaims(turns, side, limit = 8) {
  const own = (turns || []).filter((t) => t.status === 'done' && t.side === side && t.claims?.length);
  const out = [];
  for (const t of own) for (const c of t.claims) if (!out.includes(c)) out.push(c);
  return out.slice(-limit);
}

/** 抽取对方最近几段发言的开头要点，用于「对方最新论点」 */
export function recentOpponentPoints(turns, side, config) {
  const opp = side === 'pro' ? 'con' : 'pro';
  const rows = (turns || []).filter((t) => t.status === 'done' && t.side === opp).slice(-2);
  return rows.map((t) => {
    const who = config.debaters?.[opp]?.find((d) => d.id === t.speaker);
    const name = who ? who.name : `${opp}方`;
    const first = (t.content || '').split(/\n+/).filter(Boolean).slice(0, 3).join(' ');
    return `${name}在「${t.title}」中提到：${first.slice(0, 260)}`;
  });
}

const TASK_BY_TYPE = {
  opening: `这是立论陈词。结构要求：
① 先用一两句话把辩题的争夺点讲清楚，并给出你方主张的评判标准（什么算提升了思考力）；
② 抛出三个分论点，每个分论点配一条真实可查的论据或一个具体场景；
③ 结尾一句话点明你方立场的价值。
不要回应对方，因为对方还没发言。`,
  rebuttal: `这是驳论。结构要求：
① 开头明确指出对方一辩立论中最致命的那个漏洞（点名它是哪一条）；
② 用两到三个层次拆掉它：可以质疑论据来源、指出样本偏差、或者推出对方不愿接受的荒谬结论；
③ 顺势加固你方被对方攻击到的论点，给出一层新的支撑。`,
  crossQ: `这是质询环节，你向对方三辩提问。要求：
① 连续提出 4 到 6 个问题，全部是封闭式问题（能用"是/否"或"哪一个"回答），不要自问自答；
② 问题之间要有递进：从定义问到边界，从边界问到极端情形，最后逼对方承认与你方一致的前提；
③ 每个问题单独成行，用"问1：""问2："编号；
④ 结尾用一句话说明这组问题想证明什么。`,
  crossA: `这是应答质询。对方三辩刚刚向你方提问。要求：
① 逐条回应对方的问题，用"问1：…… 答：……"的格式，一个问题都不要漏；
② 回答要果断，先给结论再给理由，不要含糊其辞，也不要长篇大论（每问回答控制在 60 字内）；
③ 全部答完后，用一到两句反击，指出对方的提问预设了错误的前提。`,
  free: `这是自由辩论，节奏很快，你只有几十秒。要求：
① 第一句直接回应对方最近一次发言的具体内容，可以引用对方原话的片段；
② 第二句给出你方的新推进或一个反问；
③ 全程短句、有节奏，控制在 3 到 5 句，不要展开成大段论证。`,
  summary: `这是总结陈词，全场最后一次发言。要求：
① 先归纳本场三个核心交锋点，每个交锋点用一句话说明"争的是什么、我方为何占优"；
② 指出对方整场始终没有正面回答的那个问题，这是收官的利器；
③ 结尾升华到你方立场背后的价值（人的成长、教育的目的、这一代人的处境），要有感染力但不能煽情过度。`,
};

function researchBlock(session, side) {
  const cards = session.research?.[side];
  if (!cards?.length) return '';
  const lines = ['【你方资料库 · 可直接引用，引用时标注（机构，年份）】'];
  cards.slice(0, 6).forEach((c, i) => {
    lines.push(`${i + 1}. ${c.title}`);
    lines.push(`   来源：${c.site || hostOf(c.url)}｜${c.url}`);
    if (c.digest || c.snippet) lines.push(`   要点：${(c.digest || c.snippet).slice(0, 220)}`);
  });
  return lines.join('\n');
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function buildTurnTask({ session, phase, config }) {
  const cfg = session.config || config;
  const side = phase.side;
  const sideName = side === 'pro' ? '正方' : '反方';
  const me = cfg.debaters[side].find((d) => d.id === phase.speaker);
  const stance = side === 'pro' ? cfg.proStance : cfg.conStance;

  const myPrevious = (session.turns || [])
    .filter((t) => t.status === 'done' && t.side === side && t.speaker === phase.speaker)
    .map((t) => `· ${t.title}：${(t.content || '').replace(/\s+/g, ' ').slice(0, 160)}…`);

  const claims = extractClaims(session.turns, side);
  const oppo = recentOpponentPoints(session.turns, side, cfg);
  const research = researchBlock(session, side);

  const blocks = [
    `【本轮身份】你是${sideName}辩手「${me?.name || ''}」，担任${me?.role || ''}。`,
    `【你的风格】${me?.style || ''}`,
    `【你的长项】${me?.strengths || ''}`,
    `【你的语言习惯】${me?.tone || ''}`,
    `【你方立场】${stance}`,
  ];

  if (myPrevious.length) {
    blocks.push(`【你此前已经说过的话（不要原样复述，要在此基础上推进）】\n${myPrevious.join('\n')}`);
  } else {
    blocks.push('【你此前尚未发言，这是你的首次登场】');
  }

  if (claims.length) {
    blocks.push(`【你方已经确立的论点（保持一致，可以深化）】\n${claims.map((c) => `· ${c}`).join('\n')}`);
  }

  if (oppo.length) {
    blocks.push(`【对方最近的发言要点（必须针对性回应）】\n${oppo.map((c) => `· ${c}`).join('\n')}`);
  }

  if (research) blocks.push(research);

  if (session.interventionQueue?.length) {
    const note = session.interventionQueue[0];
    blocks.push(`【主席临时提示（必须遵守）】${note}`);
  }

  blocks.push(
    `【本轮环节】${phase.title}\n${TASK_BY_TYPE[phase.type] || ''}`
  );

  blocks.push(
    `【字数】目标 ${phase.words} 字，**上限 ${Math.ceil(phase.words * 1.15)} 字**。这是照着真人 ${(
      phase.words / (cfg.wordsPerMinute || 240)
    ).toFixed(1)} 分钟语速折算出来的，超出上限的部分裁判不计分。宁可少说一句有力的话，也不要为了凑字数注水。`
  );

  return blocks.join('\n\n');
}

/** 所有调用共享的消息骨架 */
export function buildMessages({ session, config, taskText, concise }) {
  const cfg = session.config || config;
  const system = buildGlobalSystem(cfg);
  let transcript = renderTranscript(session.turns, cfg);
  if (concise) {
    // 精简模式牺牲缓存换更短上下文：只保留最近 6 段 + 本方全部发言
    const done = (session.turns || []).filter((t) => t.status === 'done' && t.content);
    const own = done.filter((t) => t.side === taskSideOf(taskText));
    const recent = done.slice(-6);
    const keep = [...new Set([...own, ...recent])].sort((a, b) => a.order - b.order);
    transcript = renderTranscript(keep, cfg);
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: transcript },
    { role: 'user', content: taskText },
  ];
}

function taskSideOf(task) {
  if (task.includes('【本轮身份】你是正方')) return 'pro';
  if (task.includes('【本轮身份】你是反方')) return 'con';
  return 'pro';
}

/* ---------------- 检索关键词 ---------------- */

export function buildResearchTask(session, config) {
  const cfg = session.config || config;
  return `【任务】为这场辩论准备资料。辩题：${cfg.topic}

正方主张：${cfg.proStance}
反方主张：${cfg.conStance}

请输出 ${cfg.searchQueries || 5} 条中文检索式，用于在搜索引擎上查找**权威**资料（学术论文、教育部门政策、权威机构报告、认知科学/教育心理学研究）。
要求：
1. 每条检索式不超过 20 字，尽量带上机构名或"研究""报告""数据"等限定词；
2. 覆盖正方与反方各至少 2 条，其余的找双方都会用到的中性事实；
3. 只输出检索式本身，每行一条，不要编号，不要解释。`;
}

/* ---------------- 裁判 ---------------- */

export function buildJudgeTask(session, config) {
  const cfg = session.config || config;
  return `【任务】你是本场辩论的独立裁判。请根据上面的完整实录作出裁定。

${cfg.topic}
正方：${cfg.proStance}
反方：${cfg.conStance}

请严格按以下格式输出，不要添加额外章节：

## 裁定
胜方：正方 / 反方（二选一，必须明确）
比分：正方 X : Y 反方（百分制整数）
一句话理由：

## 三个决胜交锋点
1. 争点：……｜正方表现：……｜反方表现：……｜归属：……
2. （同上）
3. （同上）

## 双方最强与最弱
正方最强的一击：
正方最大的漏洞：
反方最强的一击：
反方最大的漏洞：

## 未被回答的问题
列出全场至少两个被提出但始终没人正面回答的问题。

## 哪一方更有可能说服真实听众
给出判断和理由，200 字以内。`;
}

/* ---------------- 报告 ---------------- */

export function buildReportTask(session, config, judgeText) {
  const cfg = session.config || config;
  return `【任务】把本场辩论整理成一份可以直接给人看的复盘报告，用 Markdown 输出。

要求结构：
## 一、辩题与赛制
## 二、双方论证骨架（正方 / 反方，各列 3-4 个论点，每个论点一句话概括 + 用到的关键论据）
## 三、交锋复盘（按自由辩论的轮次，逐轮写"攻方用了什么、守方怎么接、这一轮谁占上风"）
## 四、裁判结论（引用下面这段裁判意见的核心内容，可精简）
## 五、资料出处（把实录和资料库里出现过的所有来源整理成编号列表，格式：《标题》— 机构/站点，URL。没有 URL 的写清机构与年份）
## 六、给高中生的可操作建议（5 条，具体到行为，不要空话）

裁判意见原文：
${judgeText}

注意：资料出处一节必须真实来源于本次实录与资料库，不得新增未出现过的来源。`;
}
