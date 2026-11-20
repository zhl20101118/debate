// 资料检索：Tavily / Serper（有 key 时最优） → 360 搜索 → Bing → 维基百科
// 国内网络环境下 360 的中文长尾检索质量最好且无需 key，故作为默认主力后端。
// 全部零依赖（fetch + 正则），任何一路失败都不会中断辩论。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
  '&nbsp;': ' ', '&middot;': '·', '&hellip;': '…', '&mdash;': '—', '&ndash;': '–',
};

function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? m);
}

function stripTags(html = '') {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url, { timeout = 12000, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* ---------------- 相关性（中文 bigram 覆盖率） ---------------- */

function bigrams(s) {
  const t = String(s).toLowerCase().replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

function relevance(query, row) {
  const qb = bigrams(query);
  if (!qb.size) return 1;
  const rb = bigrams(`${row.title || ''} ${row.snippet || ''}`);
  let hit = 0;
  for (const g of qb) if (rb.has(g)) hit++;
  return hit / qb.size;
}

/* ---------------- 各后端 ---------------- */

async function tavily(query, limit, key) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: limit,
        search_depth: 'advanced',
        include_answer: false,
        include_raw_content: false,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Tavily ${res.status}`);
    const json = await res.json();
    return (json.results || []).map((r) => ({
      title: r.title, url: r.url, snippet: (r.content || '').slice(0, 420), backend: 'tavily',
    }));
  } finally {
    clearTimeout(t);
  }
}

async function serper(query, limit, key) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: limit, hl: 'zh-cn' }),
  });
  if (!res.ok) throw new Error(`Serper ${res.status}`);
  const json = await res.json();
  return (json.organic || []).slice(0, limit).map((r) => ({
    title: r.title, url: r.link, snippet: (r.snippet || '').slice(0, 420), backend: 'serper',
  }));
}

/** 360 搜索：中文长尾质量最好，且 data-mdurl 直接给出真实 URL */
async function so360(query, limit) {
  const html = await fetchText(`https://www.so.com/s?q=${encodeURIComponent(query)}&pn=1`, { timeout: 12000 });
  const out = [];
  const blocks = html.split(/<li class="res-list/).slice(1);
  for (const b of blocks) {
    const h = b.match(/<h3[^>]*>\s*<a([^>]*)>([\s\S]*?)<\/a>/i);
    if (!h) continue;
    const md = h[1].match(/data-mdurl="([^"]+)"/i);
    const href = h[1].match(/href="([^"]+)"/i);
    let url = decodeEntities((md && md[1]) || (href && href[1]) || '');
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripTags(h[2]);
    if (!title) continue;
    const d = b.match(/<p[^>]*res-desc[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = stripTags(d ? d[1] : '').replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*-\s*/, '').slice(0, 420);
    out.push({ title, url, snippet, backend: '360' });
    if (out.length >= limit + 3) break;
  }
  return out;
}

async function bing(query, limit) {
  const html = await fetchText(
    `https://cn.bing.com/search?q=${encodeURIComponent(query)}&mkt=zh-CN&count=${limit + 4}`,
    { timeout: 12000 }
  );
  const out = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const b of blocks) {
    const link = b.match(/<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) continue;
    const url = decodeEntities(link[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    const title = stripTags(link[2]);
    const p = b.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = stripTags(p ? p[1] : '').slice(0, 420);
    out.push({ title, url, snippet, backend: 'bing' });
    if (out.length >= limit) break;
  }
  return out;
}

async function wikipedia(query, limit) {
  const api =
    'https://zh.wikipedia.org/w/api.php?action=query&format=json&list=search&utf8=1&srlimit=' +
    limit +
    '&srsearch=' +
    encodeURIComponent(query);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 9000);
  const res = await fetch(api, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
  clearTimeout(t);
  if (!res.ok) throw new Error(`wiki ${res.status}`);
  const json = await res.json();
  return (json.query?.search || []).map((r) => ({
    title: r.title,
    url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(r.title)}`,
    snippet: stripTags(r.snippet || '').slice(0, 420),
    backend: 'wikipedia',
  }));
}

/* ---------------- 权威性打分 ---------------- */

export function authorityScore(url, authorityDomains = []) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return 0; }
  let score = 0;
  if (/\.edu\.cn$|\.edu$|\.ac\.[a-z]{2}$/.test(host)) score += 5;
  if (/\.gov\.cn$|\.gov$|\.gov\.[a-z]{2}$/.test(host)) score += 5;
  if (/(cnki|wanfang|qikan|cqvip|arxiv|nature|science|springer|sciencedirect|ieee|acm|jstor|pubmed|ncbi|doaj|eric)/.test(host)) score += 6;
  if (/(who\.int|unesco|oecd|worldbank|un\.org|apa\.org|nber\.org|brookings|pewresearch)/.test(host)) score += 5;
  // 高校学报 / 期刊站点
  if (/(xb\.|xuebao|journal|journal|periodical)/.test(host)) score += 3;
  if (/\.org\.cn$|\.org$/.test(host)) score += 1;
  for (const d of authorityDomains || []) {
    if (host === d || host.endsWith(`.${d}`)) { score += 3; break; }
  }
  // 低质量：文库、聚合页、自媒体
  if (/(book118|doc88|docin|renrendoc|mbalib|360doc|wenku|doc\.|max\.book)/.test(host)) score -= 6;
  if (/(zhihu|baijiahao|sohu|163\.com|sina|toutiao|csdn|blog|baike|wikiwand|douyin|weibo|bilibili|xiaohongshu)/.test(host)) score -= 4;
  return score;
}

/** 搜索引擎自身的聚合页 / 导航页，不是资料 */
const JUNK = /(wenku\.so\.com|tv\.360kan\.com|www\.so\.com\/s\?|so\.com\/s\?|baidu\.com\/link|zhidao\.baidu|wenda\.so\.com|www\.bing\.com\/search|cn\.bing\.com\/search|dict\.|fanyi\.|map\.)/;

function isJunk(url) {
  return JUNK.test(url);
}

/* ---------------- 对外接口 ---------------- */

/**
 * 多源检索：优先用有 key 的商业 API，其次 360，再退 Bing。
 * 返回按「相关性 × 权威性」综合排序的结果。
 */
export async function search(query, { limit = 4, authorityDomains = [], keys = {} } = {}) {
  const collectors = [];
  if (keys.tavily) collectors.push(() => tavily(query, limit + 2, keys.tavily));
  if (keys.serper) collectors.push(() => serper(query, limit + 2, keys.serper));
  collectors.push(() => so360(query, limit));
  collectors.push(() => bing(query, limit));

  let all = [];
  let lastError = null;

  // 商业 API 单独走（结果最好，拿到就够用）
  if (keys.tavily || keys.serper) {
    for (const c of collectors.slice(0, keys.tavily && keys.serper ? 2 : 1)) {
      try {
        const rows = await c();
        if (rows?.length) { all = rows; break; }
      } catch (e) { lastError = e; }
    }
  }

  if (!all.length) {
    // 360 + Bing 并发，合并去重
    const settled = await Promise.allSettled([so360(query, limit), bing(query, limit)]);
    for (const s of settled) {
      if (s.status === 'fulfilled' && s.value?.length) all.push(...s.value);
      else if (s.status === 'rejected') lastError = s.reason;
    }
  }

  if (!all.length) {
    try {
      const w = await wikipedia(query, 2);
      all = w;
    } catch (e) { lastError = e; }
  }

  const seen = new Set();
  const scored = all
    .filter((r) => {
      if (!r.url || seen.has(r.url) || isJunk(r.url)) return false;
      seen.add(r.url);
      return true;
    })
    .map((r) => {
      const rel = relevance(query, r);
      const auth = authorityScore(r.url, authorityDomains);
      return { ...r, relevance: rel, score: auth, rank: rel * 5 + auth * 3 };
    })
    .filter((r) => r.relevance >= 0.12)
    .sort((a, b) => b.rank - a.rank);

  if (!scored.length && lastError) throw lastError;
  return scored.slice(0, limit);
}

/** 抓取网页正文摘要：优先 meta description，其次正文段落 */
export async function fetchPageDigest(url, maxChars = 1600) {
  try {
    const html = await fetchText(url, { timeout: 14000 });
    const meta =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
    const abstract = meta ? stripTags(meta[1]) : '';

    const paras = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((m) => stripTags(m[1]))
      .filter((p) => p.length > 40);
    let body = paras.join(' ');

    if (body.length < 120) body = stripTags(html);
    const text = abstract.length > 80 ? `${abstract} ${body}` : body;
    return text.slice(0, maxChars);
  } catch {
    return '';
  }
}

export { stripTags, decodeEntities };
