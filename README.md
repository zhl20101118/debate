# AI 辩论室 · 4 v 4

一个跑在自己电脑上的 AI 辩论直播台：两位阵营、八位辩手，按标准 4v4 赛制实时交锋，全程可暂停、可单步、可干预，结束后自动产出带出处清单的复盘报告。

```
┌──────────────────────────────────────────────┐
│  正方一辩 立论 → 反方一辩 立论               │
│  正方二辩 驳论 → 反方二辩 驳论               │
│  正方三辩 质询 → 反方三辩 应答               │
│  反方三辩 质询 → 正方三辩 应答               │
│  自由辩论 × N 轮（双方交替）                 │
│  反方四辩 总结 → 正方四辩 总结               │
│  裁判评议 → 复盘报告                         │
└──────────────────────────────────────────────┘
```

## 特性

- **标准 4v4 赛制**：立论 / 驳论 / 攻辩质询 / 自由辩论 / 总结陈词，16 个环节，轮数与各环节时长可改。
- **八个不同的人格**：每位辩手有独立的风格、长项、语言习惯和自己的发言记忆，不是同一个模型换个马甲。
- **前缀缓存省 token**：所有调用共享同一段「全局规则 + 辩论实录」前缀，差异只放在最后一条消息。实测长会话缓存命中率可达 70%–90%，输入成本降到十分之一。
- **实时直播**：SSE 推流，打字机效果，局域网内手机 / 平板同看。
- **全程可控**：暂停 / 继续 / 单步 / 跳过 / 撤回上一轮 / 结束 / 给主席留言（临时干预下一位发言者）。
- **思考过程默认折叠**：启用推理模型时，思考链单独收在一个可展开的折叠区里。
- **会查资料**：开场前自动生成检索式、抓取权威来源（高校学报 / 政策文件 / 学术期刊），并把资料卡喂给双方辩手。
- **本地存储**：全部数据落在 `data/`，不经过任何第三方服务器；报告是 Markdown。
- **零依赖**：只用 Node 内置模块，`npm install` 都不需要。

## 快速开始

```bash
# 1. 需要 Node 18+
node -v

# 2. 启动（二选一）
./start.bat          # Windows 双击也行
node server.js       # 任意平台

# 3. 打开 http://localhost:8787
```

首次使用要在网页右上角 **⚙ 设置** 里填入 DeepSeek API Key，或者：

```bash
cp .env.example .env    # 然后编辑 .env 填入 DEEPSEEK_API_KEY
```

Key 只会写进 `data/secrets.json`（已被 `.gitignore` 忽略），**永远不会进入代码仓库**。

## 配置

网页「设置」里能改，也可以直接编辑 `data/config.json`：

| 字段 | 说明 | 默认 |
| --- | --- | --- |
| `topic` | 辩题 | 高中生使用 AI 辅助学习，提升了 / 降低了思考力 |
| `proStance` / `conStance` | 双方立场表述 | — |
| `model` | `deepseek-chat` / `deepseek-reasoner` | deepseek-chat |
| `reasoningEffort` | `off` / `low` / `medium` / `high` | medium |
| `rounds` | 自由辩论轮数 | 3 |
| `wordsPerMinute` | 折算字数的语速（中文辩论约 240 字/分） | 240 |
| `minutes` | 各环节时长，决定每位辩手的字数 | 3 / 2 / 1.5 / 1 / 0.7 / 3.5 |
| `searchEnabled` | 开场前是否检索资料 | true |
| `conciseContext` | 精简上下文（更省，但缓存命中下降） | false |
| `judgeEnabled` | 结束后是否裁判裁定 | true |

**思考强度与模型的关系**：`off` / `low` 走 `deepseek-chat`（快、便宜）；`medium` / `high` 自动启用 `deepseek-reasoner`（有思考链，慢一些但论证更扎实）。

## 关于 token 与缓存

DeepSeek 用的是**前缀缓存**：只要这次请求的 messages 前缀和上次逐字节一致，前缀部分就按缓存价计费（约 1/10）。

所以本项目刻意把所有调用组织成三条消息：

```
[0] system  ← 全局规则 + 辩题 + 赛制（整场不变）
[1] user    ← 辩论实录（只追加、不修改，天然是稳定前缀）
[2] user    ← 本轮任务（唯一变化的部分：我是谁、本轮要干嘛）
```

八位辩手、裁判、报告生成全部共用 `[0]` 和 `[1]`，差异只在 `[2]` 的尾巴上。这样每多一轮，前面几万 token 的历史几乎全部命中缓存。

界面上实时显示 `命中 / 未命中`、命中率环和估算成本。实测（3 轮 16 次发言 + 裁判 + 报告）：缓存命中率 70%–90%。

## 目录结构

```
debate/
├─ server.js            # HTTP + SSE 服务（零依赖）
├─ start.bat            # Windows 一键启动
├─ src/
│  ├─ config.js         # 默认配置、8 位辩手人格、赛制展开
│  ├─ deepseek.js       # 流式客户端、重试、缓存统计
│  ├─ prompts.js        # 提示词（缓存友好结构）
│  ├─ orchestrator.js   # 赛制状态机、控制指令、裁判与报告
│  ├─ search.js         # 多源检索 + 权威性打分
│  ├─ store.js          # 本地 JSON 存储
│  └─ paths.js
├─ public/              # 前端（原生 JS，无框架）
└─ data/                # 运行时生成，已被 gitignore
   ├─ sessions/         # 每场辩论的完整记录
   ├─ reports/          # Markdown 报告
   ├─ config.json
   └─ secrets.json      # API Key，绝不入库
```

## 管理控制

启动时设置 `ADMIN_TOKEN`，控制类操作就需要带口令（网页端会弹窗询问一次，存到 localStorage）：

```bash
ADMIN_TOKEN=mysecret node server.js
```

不设置则同一局域网内任何人都能控制进度 —— 只想给人看、不想给人动的话建议设上。

## 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/config` | 读取配置 |
| POST | `/api/config` | 修改配置 |
| GET/POST | `/api/secrets` | 查看 / 写入 API Key |
| GET/POST | `/api/sessions` | 列表 / 新建 |
| GET | `/api/sessions/:id` | 单场详情 |
| GET | `/api/sessions/:id/stream` | SSE 实时流 |
| POST | `/api/sessions/:id/control` | `start` `pause` `resume` `step` `skip` `rewind` `stop` `inject` `regenerate-report` |
| GET | `/api/sessions/:id/report` | 报告（`?download=1` 下载） |

## 注意事项

- 辩手会引用检索到的资料，但**模型仍可能记错具体数字**。报告末尾的「来源清单」是机器汇总的可核查链接，引用前请点开确认。
- 一场 3 轮辩论约消耗 3–8 万 token（视历史长度），成本在几毛钱以内。
- 检索走的是公开搜索结果页，量大时可能被限流；配 `TAVILY_API_KEY` 或 `SERPER_API_KEY` 会稳很多。

## License

MIT
