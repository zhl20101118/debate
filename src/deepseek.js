// DeepSeek 客户端：流式 + 自动重试 + 缓存命中统计
//
// 缓存要点：DeepSeek 用「前缀缓存」。同一次请求的 messages 只要与之前某次请求
// 逐字节共享一段前缀（按 64 token 对齐），这段就按缓存价计费。
// 所以本项目把所有调用组织成不断追加的多轮对话：历史只增加、从不改写，
// 每位辩手的差异只出现在最后一条任务消息里。

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class DeepSeekError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.detail = detail;
  }
}

export function normalizeUsage(u) {
  if (!u) return null;
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? (u.prompt_tokens ? Math.max(0, u.prompt_tokens - hit) : 0);
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    cacheHitRate: hit + miss > 0 ? hit / (hit + miss) : 0,
  };
}

/**
 * 流式对话。onDelta({type:'content'|'reasoning', text}) 实时回调。
 * 返回 { content, reasoning, usage, model, firstTokenMs, elapsedMs }
 */
export async function streamChat({
  apiKey,
  baseUrl = 'https://api.deepseek.com',
  model = 'deepseek-chat',
  messages,
  maxTokens = 4096,
  temperature = 1.0,
  signal,
  onDelta,
  retries = 2,
  timeoutMs = 300000,
}) {
  if (!apiKey) {
    throw new DeepSeekError('缺少 API Key：请在网页「设置」里填写，或设置环境变量 DEEPSEEK_API_KEY', 0);
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const body = { model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens };
  // reasoner 不接受采样参数
  if (!/reasoner/i.test(model)) {
    body.temperature = temperature;
    body.frequency_penalty = 0.2;
  }

  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await runOnce({ url, body, apiKey, signal, onDelta, timeoutMs });
    } catch (err) {
      lastErr = err;
      const status = err.status || 0;
      const retryable = RETRYABLE.has(status) || status === 0;
      if (!retryable || attempt === retries || signal?.aborted) break;
      await sleep(Math.min(8000, 700 * 2 ** attempt));
      attempt++;
    }
  }
  throw lastErr;
}

async function runOnce({ url, body, apiKey, signal, onDelta, timeoutMs }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  const t0 = Date.now();
  let firstTokenMs = 0;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (signal?.aborted) throw new DeepSeekError('已取消', -1);
    throw new DeepSeekError(`网络请求失败：${e.message}`, 0);
  }

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    throw new DeepSeekError(explainStatus(res.status, text), res.status, text.slice(0, 500));
  }

  let content = '';
  let reasoning = '';
  let usage = null;
  let buf = '';
  const decoder = new TextDecoder('utf-8');

  try {
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        if (json.usage) usage = normalizeUsage(json.usage);
        const delta = json.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.reasoning_content) {
          if (!firstTokenMs) firstTokenMs = Date.now() - t0;
          reasoning += delta.reasoning_content;
          onDelta?.({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.content) {
          if (!firstTokenMs) firstTokenMs = Date.now() - t0;
          content += delta.content;
          onDelta?.({ type: 'content', text: delta.content });
        }
      }
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  // 流意外中断且没拿到 usage 时，给个粗略估算，避免统计面板空白
  if (!usage) {
    const promptChars = (body.messages || []).reduce((a, m) => a + String(m.content || '').length, 0);
    const promptTokens = Math.round(promptChars * 0.62);
    const completionTokens = Math.round((content.length + reasoning.length) * 0.62);
    usage = normalizeUsage({
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: promptTokens,
    });
  }

  return { content, reasoning, usage, model: body.model, firstTokenMs, elapsedMs: Date.now() - t0 };
}

function explainStatus(status, text) {
  const map = {
    400: '请求参数有误（400）',
    401: 'API Key 无效或已失效（401）',
    402: '账户余额不足，请到 DeepSeek 平台充值（402）',
    422: '请求格式错误（422）',
    429: '触发限流，请稍后重试（429）',
    500: 'DeepSeek 服务端错误（500）',
    503: 'DeepSeek 服务繁忙（503）',
  };
  const base = map[status] || `请求失败（${status}）`;
  const brief = String(text || '').replace(/\s+/g, ' ').slice(0, 200);
  return brief ? `${base}：${brief}` : base;
}
