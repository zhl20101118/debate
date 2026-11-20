// DeepSeek 客户端：流式 + 自动重试 + 缓存命中统计
// 缓存要点：DeepSeek 是「前缀缓存」，只要 messages 的前缀逐字节一致就会命中。
// 所以本项目的所有调用都刻意共享同一段前缀（全局规则 + 单调增长的辩论记录），
// 把每个辩手的角色差异放到最后一条消息里 —— 这样既保留个性，又不破坏缓存。

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

function normalizeUsage(u) {
  if (!u) return null;
  const hit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? (u.prompt_tokens ? u.prompt_tokens - hit : 0);
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
    cacheHitTokens: hit,
    cacheMissTokens: miss,
  };
}

/**
 * 流式对话。onDelta({type:'content'|'reasoning', text}) 实时回调。
 * 返回 { content, reasoning, usage, model }
 */
export async function streamChat({
  apiKey,
  baseUrl = 'https://api.deepseek.com',
  model = 'deepseek-chat',
  messages,
  maxTokens = 2048,
  temperature = 1.0,
  thinking = false,
  signal,
  onDelta,
  retries = 2,
}) {
  if (!apiKey) throw new DeepSeekError('缺少 API Key：请在网页「设置」里填写，或设置环境变量 DEEPSEEK_API_KEY', 0);

  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const body = {
    model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: maxTokens,
  };
  // deepseek-reasoner 不接受 temperature 等采样参数
  if (!/reasoner/i.test(model)) {
    body.temperature = temperature;
    body.frequency_penalty = 0.2;
  }

  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await runOnce({ url, body, apiKey, signal, onDelta });
    } catch (err) {
      lastErr = err;
      const status = err.status || 0;
      const retryable = RETRYABLE.has(status) || err.name === 'AbortError' && false;
      if (!retryable || attempt === retries || signal?.aborted) break;
      const wait = Math.min(8000, 600 * 2 ** attempt);
      await sleep(wait);
      attempt++;
    }
  }
  throw lastErr;
}

async function runOnce({ url, body, apiKey, signal, onDelta }) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), 240_000);

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
          reasoning += delta.reasoning_content;
          onDelta?.({ type: 'reasoning', text: delta.reasoning_content });
        }
        if (delta.content) {
          content += delta.content;
          onDelta?.({ type: 'content', text: delta.content });
        }
      }
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  return { content, reasoning, usage, model: body.model };
}

/** 非流式调用，用于检索关键词、裁判等短任务 */
export async function chatOnce(opts) {
  const r = await streamChat({ ...opts, onDelta: undefined });
  return r;
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
