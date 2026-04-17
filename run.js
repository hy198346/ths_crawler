const { spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const tunnel = require('tunnel');

// 配置参数
const IS_GITHUB_ACTIONS = String(process.env.GITHUB_ACTIONS || '').toLowerCase() === 'true';
const MAX_RETRIES = Number(process.env.MAX_RETRIES || (IS_GITHUB_ACTIONS ? 2 : 5));
const RETRY_INTERVAL = Number(process.env.RETRY_INTERVAL_MS || (IS_GITHUB_ACTIONS ? 60000 : 120000));
const EXEC_TIMEOUT = Number(process.env.EXEC_TIMEOUT_MS || (IS_GITHUB_ACTIONS ? 15 * 60 * 1000 : 30 * 60 * 1000));
const SUCCESS_FLAG = 'created'; // 成功标识
const SERVERCHAN_KEY = process.env.SERVERCHAN_KEY; // 从环境变量获取Server酱密钥
const EMAIL_MONITOR_ADDR = process.env.EMAIL_MONITOR_ADDR;
const EMAIL_MONITOR_AUTH = process.env.EMAIL_MONITOR_AUTH;
const EMAIL_MONITOR_WEBHOOK_KEY = process.env.EMAIL_MONITOR_WEBHOOK_KEY;
const LLM_MODEL = process.env.KIMI_MODEL || process.env.LLM_MODEL || 'kimi-k2-turbo-preview';
const LLM_BASE_URL = (process.env.KIMI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.KIMI_API_KEY || process.env.LLM_API_KEY || '';
const LLM_DEBUG = ['1', 'true', 'yes', 'on'].includes(String(process.env.KIMI_DEBUG || process.env.LLM_DEBUG || '').trim().toLowerCase());

let retryCount = 0;

let tunnelHttpsAgent = null;

function cleanOneLine(s) {
  return String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function appendTail(cur, chunk, maxChars) {
  const cap = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 0;
  const next = `${String(cur || '')}${String(chunk || '')}`;
  if (!cap) return next;
  return next.length > cap ? next.slice(next.length - cap) : next;
}

function cutByChars(s, maxChars) {
  const t = cleanOneLine(s);
  const n = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : 0;
  if (!n) return t;
  return t.length > n ? t.slice(0, n) : t;
}

function llmDebugLog(msg) {
  if (!LLM_DEBUG) return;
  console.log(String(msg || ''));
}

function getTunnelProxyConfig() {
  const tunnelStr = process.env.TUNNEL_PROXY ? String(process.env.TUNNEL_PROXY) : '';
  const username = process.env.TUNNEL_USERNAME ? String(process.env.TUNNEL_USERNAME) : '';
  const password = process.env.TUNNEL_PASSWORD ? String(process.env.TUNNEL_PASSWORD) : '';
  if (!tunnelStr || !username || !password) return null;
  const [host, portStr] = tunnelStr.split(':');
  const port = Number(portStr);
  if (!host || !Number.isFinite(port) || port <= 0) return null;
  return { host, port, proxyAuth: `${username}:${password}` };
}

function getHttpsAgentForUrl(targetUrl) {
  const proxy = getTunnelProxyConfig();
  if (!proxy) return undefined;
  if (targetUrl.protocol !== 'https:') return undefined;
  if (!tunnelHttpsAgent) {
    tunnelHttpsAgent = tunnel.httpsOverHttp({ proxy, maxSockets: 50 });
  }
  return tunnelHttpsAgent;
}

function requestJson(targetUrl, { method = 'GET', headers = {}, body = null, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: targetUrl.hostname,
        port: targetUrl.port || 443,
        path: `${targetUrl.pathname}${targetUrl.search}`,
        method,
        headers,
        agent: getHttpsAgentForUrl(targetUrl),
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode !== 200) {
            const err = new Error(`Status code: ${res.statusCode}`);
            err.statusCode = res.statusCode;
            err.body = buf.toString();
            return reject(err);
          }
          const text = buf.toString();
          let j;
          try {
            j = JSON.parse(text);
          } catch {
            j = null;
          }
          if (!j || typeof j !== 'object') {
            const err = new Error('Invalid JSON');
            err.body = text.slice(0, 800);
            return reject(err);
          }
          resolve(j);
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (body) req.write(body);
    req.end();
  });
}

function parseJsonFromLlm(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const sub = s.slice(start, end + 1);
  try {
    return JSON.parse(sub);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function getExternUserFileSizeForNotice() {
  const externUserPath = path.resolve(__dirname, 'extern_user.txt');
  try {
    const stat = fs.statSync(externUserPath);
    if (!stat.isFile()) return '不是文件';
    return `${formatBytes(stat.size)} (${stat.size} B)`;
  } catch (e) {
    if (e && e.code === 'ENOENT') return '文件不存在';
    return '读取失败';
  }
}

function getAnnouncementSummaryForNotice() {
  const annPath = path.resolve(__dirname, 'extern_user_ann.txt');
  const maxLines = Number(process.env.ANNOUNCE_NOTICE_MAX_LINES || 30);
  const maxChars = Number(process.env.ANNOUNCE_NOTICE_MAX_CHARS || 4000);
  try {
    const raw = fs.readFileSync(annPath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const out = [];
    let used = 0;
    for (let i = 0; i < lines.length && out.length < maxLines; i += 1) {
      const parts = lines[i].split('|');
      if (parts.length < 5) continue;
      const stockId = parts[1];
      const text = parts[3];
      const one = `- ${stockId} ${text}`;
      used += one.length;
      if (used > maxChars) break;
      out.push(one);
    }
    if (out.length === 0) return '';
    const more = lines.length > out.length ? `\n\n...(${lines.length - out.length} 条未展示)` : '';
    return `### 📌 公告摘要（type 22）\n\n${out.join('\n')}${more}`;
  } catch (e) {
    return '';
  }
}

function parseAnnouncementFileForLlm() {
  const annPath = path.resolve(__dirname, 'extern_user_ann.txt');
  const raw = fs.readFileSync(annPath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const items = [];
  const excludeMidnightToday = !['0', 'false', 'no', 'off'].includes(String(process.env.ANNOUNCE_KIMI_EXCLUDE_MIDNIGHT || '0').trim().toLowerCase());
  const today = excludeMidnightToday
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    : '';
  const windowHours = Number(process.env.ANNOUNCE_KIMI_WINDOW_HOURS || 24);
  const nowMs = Date.now();
  const windowStartMs = Number.isFinite(windowHours) && windowHours > 0 ? nowMs - Math.floor(windowHours * 3600 * 1000) : 0;
  const parseShanghaiEpoch = (s) => {
    const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2}):(\d{2})\b/.exec(String(s || '').trim());
    if (!m) return 0;
    const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}+08:00`;
    const t = Date.parse(iso);
    return Number.isFinite(t) ? t : 0;
  };
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const stockId = String(parts[1] || '').trim();
    const text = cleanOneLine(parts[3] || '');
    if (!stockId || !text) continue;
    if (excludeMidnightToday) {
      const m = text.match(/^(\d{4}-\d{2}-\d{2})\s+00:00:00\b/);
      if (m && m[1] === today) continue;
    }
    if (windowStartMs) {
      const ts = parseShanghaiEpoch(text);
      if (!ts || ts < windowStartMs || ts > nowMs + 60000) continue;
    }
    items.push({ stockId, text });
  }
  return { count: items.length, items };
}

function loadStockNameMap() {
  const p = process.env.STOCK_LIST_PATH
    ? path.resolve(process.env.STOCK_LIST_PATH)
    : path.resolve(__dirname, 'stock_list.json');
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.stocks) ? j.stocks : []);
    const m = new Map();
    for (const it of arr) {
      const code = it && it.f12 ? String(it.f12).trim() : '';
      const name = it && it.f14 ? String(it.f14).trim() : '';
      if (!code || !name) continue;
      if (!m.has(code)) m.set(code, name);
    }
    return m;
  } catch {
    return new Map();
  }
}

function injectStockNamesIntoKimiSection(markdown, nameMap) {
  const text = String(markdown || '');
  if (!text || !text.includes('Kimi精选')) return text;
  const lines = text.split(/\r?\n/);
  let inKimi = false;
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('###')) {
      inKimi = trimmed.includes('Kimi精选');
      out.push(line);
      continue;
    }
    if (!inKimi) {
      out.push(line);
      continue;
    }
    const m = line.match(/^\s*-\s*(\d{6})\b(.*)$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const code = m[1];
    const name = nameMap && nameMap.get(code) ? String(nameMap.get(code)) : '';
    if (!name) {
      out.push(line);
      continue;
    }
    const rest = String(m[2] || '');
    const restTrim = rest.trimStart();
    if (restTrim.startsWith(name)) {
      out.push(line);
      continue;
    }
    const joiner = restTrim && /^[：:，,。．、;；!?！？]/.test(restTrim) ? '' : (restTrim ? ' ' : '');
    out.push(`- ${code} ${name}${joiner}${restTrim}`);
  }
  return out.join('\n');
}

function getKimiDigestCachePath() {
  if (process.env.ANNOUNCE_KIMI_CACHE_PATH) return path.resolve(process.env.ANNOUNCE_KIMI_CACHE_PATH);
  return path.resolve(__dirname, 'extern_user_kimi_digest.md');
}

function loadKimiDigestCache() {
  const p = getKimiDigestCachePath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return String(raw || '').trim();
  } catch {
    return '';
  }
}

function saveKimiDigestCache(markdown) {
  const p = getKimiDigestCachePath();
  const s = String(markdown || '').trim();
  if (!s) return;
  try {
    fs.writeFileSync(p, `${s}\n`, 'utf8');
  } catch {}
}

function getShanghaiDayString() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function extractKimiDigestItems(markdown) {
  const text = String(markdown || '');
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = String(line || '').trim();
    if (!t.startsWith('- ')) continue;
    out.push(t);
  }
  return out;
}

function parseKimiDigestMeta(markdown) {
  const text = String(markdown || '');
  const mDate = /日期[:：]\s*(\d{4}-\d{2}-\d{2})/.exec(text);
  const mCnt = /共\s*(\d+)\s*条公告/.exec(text);
  return {
    date: mDate ? String(mDate[1] || '').trim() : '',
    totalCount: mCnt ? Number(mCnt[1]) : 0,
    items: extractKimiDigestItems(text)
  };
}

function renderKimiDigestMarkdown(items, totalCount, dayStr) {
  const arr = Array.isArray(items) ? items.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!arr.length) return '';
  const cnt = Number.isFinite(Number(totalCount)) && Number(totalCount) > 0 ? Math.floor(Number(totalCount)) : 0;
  const day = String(dayStr || '').trim();
  const tailParts = [];
  if (day) tailParts.push(`日期：${day}`);
  if (cnt) tailParts.push(`共${cnt}条公告`);
  const tail = tailParts.length ? `\n\n（${tailParts.join('，')}）` : '';
  return `### 📌 公告要闻（Kimi精选）\n\n${arr.join('\n')}${tail}`;
}

function mergeKimiDigestDaily(newMd, parsedCount, maxItems) {
  const today = getShanghaiDayString();
  const newItems = extractKimiDigestItems(newMd);
  if (!newItems.length) return String(newMd || '');
  const cap = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : 30;
  const oldMd = loadKimiDigestCache();
  const oldMeta = parseKimiDigestMeta(oldMd);
  const shouldMergeOld = oldMeta.items.length > 0 && (!oldMeta.date || oldMeta.date === today);
  const oldItems = shouldMergeOld ? oldMeta.items : [];
  const maxCountPrev = shouldMergeOld && Number.isFinite(Number(oldMeta.totalCount)) ? Number(oldMeta.totalCount) : 0;
  const uniq = [];
  const seen = new Set();
  const pushOne = (s) => {
    const t = String(s || '').trim();
    if (!t) return;
    if (seen.has(t)) return;
    seen.add(t);
    uniq.push(t);
  };
  for (const it of newItems) pushOne(it);
  for (const it of oldItems) pushOne(it);
  const merged = uniq.slice(0, cap);
  const maxCount = Math.max(Number.isFinite(Number(parsedCount)) ? Number(parsedCount) : 0, maxCountPrev);
  const outMd = renderKimiDigestMarkdown(merged, maxCount, today) || String(newMd || '');
  saveKimiDigestCache(outMd);
  return outMd;
}

function getKimiSelectionCachePath() {
  if (process.env.ANNOUNCE_KIMI_SELECT_CACHE_PATH) return path.resolve(process.env.ANNOUNCE_KIMI_SELECT_CACHE_PATH);
  return path.resolve(__dirname, 'extern_user_kimi_select.json');
}

function loadKimiSelectionCache() {
  const p = getKimiSelectionCachePath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(String(raw || ''));
    if (!j || typeof j !== 'object') return null;
    return j;
  } catch {
    return null;
  }
}

function saveKimiSelectionCache(obj) {
  const p = getKimiSelectionCachePath();
  try {
    fs.writeFileSync(p, `${JSON.stringify(obj || {}, null, 2)}\n`, 'utf8');
  } catch {}
}

function normalizeKimiSelection(obj) {
  const safeArr = (v) => (Array.isArray(v) ? v.map((x) => cleanOneLine(x)).filter(Boolean) : []);
  const out = {
    ann_good: safeArr(obj && obj.ann_good),
    perf_good: safeArr(obj && obj.perf_good),
    ann_bad: safeArr(obj && obj.ann_bad),
    perf_bad: safeArr(obj && obj.perf_bad)
  };
  return out;
}

function formatKimiSelectionMessage(obj) {
  const s = normalizeKimiSelection(obj);
  const clip15 = (arr) => arr.slice(0, 15);
  const section = (title, arr) => {
    const items = clip15(arr);
    if (!items.length) return `${title}\n\n无`;
    return `${title}\n\n${items.join('\n')}`;
  };
  return [
    'Kimi精选',
    '',
    section('一、公告利好', s.ann_good),
    '',
    section('二、业绩利好', s.perf_good),
    '',
    section('三、公告利空', s.ann_bad),
    '',
    section('四、业绩利空', s.perf_bad)
  ].join('\n');
}

async function getKimiSelectionByKimi() {
  if (!LLM_API_KEY) return null;
  let parsed;
  try {
    parsed = parseAnnouncementFileForLlm();
  } catch {
    return null;
  }
  if (!parsed || !parsed.count) return null;

  const maxInLines = Number(process.env.ANNOUNCE_KIMI_INPUT_MAX_LINES || 800);
  const maxInChars = Number(process.env.ANNOUNCE_KIMI_INPUT_MAX_CHARS || 120000);
  const safeMaxLines = Number.isFinite(maxInLines) && maxInLines > 0 ? Math.floor(maxInLines) : 800;
  const safeMaxChars = Number.isFinite(maxInChars) && maxInChars > 2000 ? Math.floor(maxInChars) : 120000;

  const picked = [];
  let used = 0;
  for (const it of parsed.items) {
    if (picked.length >= safeMaxLines) break;
    const one = `${it.stockId} ${it.text}`;
    used += one.length + 1;
    if (used > safeMaxChars) break;
    picked.push(one);
  }

  const prompt = [
    '你是严谨的中文财经快讯编辑。',
    '请从下列公告摘要中进行“精选+分类”，输出严格 JSON（不要 markdown，不要解释，不要额外文本）。',
    '',
    '分类与字段：',
    '- ann_good：公告利好（非业绩类）',
    '- perf_good：业绩利好（财报/业绩快报/业绩预告/分红等偏利好）',
    '- ann_bad：公告利空（非业绩类）',
    '- perf_bad：业绩利空（财报/业绩快报/业绩预告等偏利空）',
    '',
    '输出要求：',
    '- JSON 顶层只允许包含 4 个字段：ann_good, perf_good, ann_bad, perf_bad',
    '- 每个字段的值是字符串数组，每类最多 15 条，按重要性降序',
    '- 每条字符串格式必须是“股票名：要点”',
    '- 要点尽量 <= 50 个汉字，信息密度高，只写事实不推测/不编造，数字与单位尽量原样保留',
    '- 若没有可选条目，对应数组返回空数组 []',
    '',
    `公告列表（共${parsed.count}条，输入给你的是前${picked.length}条）：`,
    ...picked
  ].join('\n');

  const url = `${LLM_BASE_URL}/chat/completions`;
  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: '你是严谨的中文财经快讯编辑。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  });
  try {
    llmDebugLog(`MAIL LLM select req: model=${LLM_MODEL} host=${new URL(url).host} promptChars=${prompt.length} bodyBytes=${Buffer.byteLength(body)}`);
    const j = await requestJson(new URL(url), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept-Encoding': 'identity'
      },
      body,
      timeoutMs: Number(process.env.ANNOUNCE_KIMI_TIMEOUT_MS || 30000)
    });
    llmDebugLog('MAIL LLM select res: json=ok');
    const content = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    const parsedJson = parseJsonFromLlm(content);
    if (!parsedJson) return null;
    const normalized = normalizeKimiSelection(parsedJson);
    saveKimiSelectionCache(normalized);
    return normalized;
  } catch (e) {
    const sc = e && e.statusCode ? String(e.statusCode) : '';
    console.warn(`MAIL LLM select failed: status=${sc || 'na'} err=${e && e.message ? e.message : e}`);
    if (e && e.body) console.warn(`MAIL LLM select body: ${cutByChars(e.body, 300)}`);
    return null;
  }
}

async function getAnnouncementDigestByKimi() {
  if (!LLM_API_KEY) return '';
  let parsed;
  try {
    parsed = parseAnnouncementFileForLlm();
  } catch {
    return '';
  }
  if (!parsed || !parsed.count) return '';

  const topN = Number(process.env.ANNOUNCE_KIMI_TOP_N || 30);
  const maxInLines = Number(process.env.ANNOUNCE_KIMI_INPUT_MAX_LINES || 800);
  const maxInChars = Number(process.env.ANNOUNCE_KIMI_INPUT_MAX_CHARS || 120000);
  const safeTopN = Number.isFinite(topN) && topN > 0 ? Math.floor(topN) : 10;
  const safeMaxLines = Number.isFinite(maxInLines) && maxInLines > 0 ? Math.floor(maxInLines) : 800;
  const safeMaxChars = Number.isFinite(maxInChars) && maxInChars > 2000 ? Math.floor(maxInChars) : 120000;

  const picked = [];
  let used = 0;
  for (const it of parsed.items) {
    if (picked.length >= safeMaxLines) break;
    const one = `${it.stockId} ${it.text}`;
    used += one.length + 1;
    if (used > safeMaxChars) break;
    picked.push(one);
  }

  const prompt = [
    `你是财经快讯编辑。请从下列公告中精选最重要的${safeTopN}条，输出用于短信/邮件的“公告要闻”。`,
    '要求：',
    `- 只输出${safeTopN}条（不足则全输出），按重要性降序`,
    '- 每条一行，用“- 代码 要点”格式',
    '- 要点要像财经网站标题一样精炼（尽量<=40个汉字），信息密度高，只写事实不推测/不编造，数字和单位尽量原样保留',
    '- 不要出现公司名称/简称/股票名称（可用“公司”代替或省略主语）',
    '- 多篇公告：优先挑选业绩/财报/分红/业绩预告等，其次重大资产/增减持/回购/监管/诉讼/重大合同/股权变动等',
    '',
    `公告列表（共${parsed.count}条，输入给你的是前${picked.length}条）：`,
    ...picked
  ].join('\n');

  const url = `${LLM_BASE_URL}/chat/completions`;
  const t0 = Date.now();
  const body = JSON.stringify({
    model: LLM_MODEL,
    messages: [
      { role: 'system', content: '你是严谨的中文财经快讯编辑。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.2
  });
  try {
    llmDebugLog(`MAIL LLM req: model=${LLM_MODEL} host=${new URL(url).host} promptChars=${prompt.length} bodyBytes=${Buffer.byteLength(body)}`);
    const j = await requestJson(new URL(url), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LLM_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept-Encoding': 'identity'
      },
      body,
      timeoutMs: Number(process.env.ANNOUNCE_KIMI_TIMEOUT_MS || 30000)
    });
    llmDebugLog(`MAIL LLM res: ms=${Date.now() - t0} json=ok`);
    const content = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
    const out = String(content || '');
    const normalized = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).join('\n\n');
    if (!normalized) return '';
    const md = `### 📌 公告要闻（Kimi精选）\n\n${normalized}\n\n（共${parsed.count}条公告）`;
    return mergeKimiDigestDaily(md, parsed.count, safeTopN);
  } catch (e) {
    const sc = e && e.statusCode ? String(e.statusCode) : '';
    console.warn(`MAIL LLM digest failed: status=${sc || 'na'} err=${e && e.message ? e.message : e}`);
    if (e && e.body) console.warn(`MAIL LLM digest body: ${cutByChars(e.body, 300)}`);
    return '';
  }
}

function getLlmAlertSummaryForNotice(stdout, stderr) {
  const text = `${String(stdout || '')}\n${String(stderr || '')}`;
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const alerts = lines.filter((line) => line.includes('ANN LLM ALERT:'));
  const errors = lines.filter((line) => line.includes('ANN LLM ERROR:'));
  if (alerts.length === 0 && errors.length === 0) return '';
  const out = [];
  out.push('### ⚠️ 大模型告警');
  for (const a of alerts.slice(0, 3)) out.push(`- ${a}`);
  for (const e of errors.slice(0, 8)) out.push(`- ${e}`);
  if (errors.length > 8) out.push(`- 其余 ${errors.length - 8} 条错误已省略（详见任务日志）`);
  return out.join('\n');
}

function parseAnnMergeStatsFromStdout(stdout) {
  const text = String(stdout || '');
  const re = /total\s*=\s*(\d+)[^\d]+new\s*=\s*(\d+)[^\d]+updated\s*=\s*(\d+)[^\d]+unchanged\s*=\s*(\d+)/g;
  let last = null;
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    last = {
      total: Number(m[1]),
      added: Number(m[2]),
      updated: Number(m[3]),
      unchanged: Number(m[4])
    };
  }
  if (!last) return null;
  if (![last.total, last.added, last.updated, last.unchanged].every((n) => Number.isFinite(n) && n >= 0)) return null;
  return last;
}

// 发送消息到Server酱的函数
function buildServerChanRequest(message, key) {
  const body = new URLSearchParams({
    title: '同花顺概念更新成功',
    desp: String(message || '')
  }).toString();

  const options = {
    hostname: 'sctapi.ftqq.com',
    path: `/${key}.send`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
      'Accept-Encoding': 'identity'
    }
  };

  return { options, body };
}

function sendServerChan(message) {
  if (!SERVERCHAN_KEY) {
    console.warn('未设置SERVERCHAN_KEY，跳过Server酱通知');
    return Promise.resolve(false);
  }

  const { options, body } = buildServerChanRequest(message, SERVERCHAN_KEY);

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => responseBody += chunk);
      res.on('end', () => {
        console.log('Server酱通知状态:', res.statusCode);
        try {
          const result = JSON.parse(responseBody);
          if (result.code === 0) {
            console.log('✅ Server酱通知发送成功');
            resolve(true);
          } else {
            console.error('❌ Server酱发送失败:', result.message);
            resolve(false);
          }
        } catch (e) {
          console.error('Server酱响应解析失败:', e.message);
          resolve(false);
        }
      });
    });

    req.setTimeout(15000, () => {
      req.destroy(new Error('Server酱请求超时'));
    });

    req.on('error', (error) => {
      console.error('Server酱请求失败:', error.message);
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

async function sendWeComMarkdown(content) {
  const key = String(EMAIL_MONITOR_WEBHOOK_KEY || '').trim();
  if (!key) {
    console.warn('未设置 EMAIL_MONITOR_WEBHOOK_KEY，跳过企业微信通知');
    return false;
  }
  const url = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(key)}`;
  const body = JSON.stringify({
    msgtype: 'markdown',
    markdown: { content: String(content || '') }
  });
  try {
    const j = await requestJson(new URL(url), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Accept-Encoding': 'identity'
      },
      body,
      timeoutMs: Number(process.env.WECOM_TIMEOUT_MS || 15000)
    });
    const errcode = Number(j && j.errcode != null ? j.errcode : NaN);
    if (errcode === 0) {
      console.log('✅ 企业微信通知发送成功');
      return true;
    }
    console.error(`❌ 企业微信发送失败: errcode=${String(j && j.errcode)} errmsg=${String(j && j.errmsg)}`);
    return false;
  } catch (e) {
    console.error(`企业微信请求失败: ${e && e.message ? e.message : e}`);
    return false;
  }
}

function trimWeComMarkdown(content) {
  const maxChars = Number(process.env.WECOM_MAX_CHARS || 3800);
  const s = String(content || '');
  const cap = Number.isFinite(maxChars) && maxChars > 200 ? Math.floor(maxChars) : 3800;
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n\n...(内容过长已截断)`;
}

function buildWeComNotice({ kimiSelectionText, kimiDigestMarkdown }) {
  const parts = [];
  const sel = String(kimiSelectionText || '').trim();
  const dig = String(kimiDigestMarkdown || '').trim();
  if (sel) {
    parts.push('### Kimi精选（分类）');
    parts.push(sel);
  }
  if (dig) parts.push(dig);
  return trimWeComMarkdown(parts.filter(Boolean).join('\n\n---\n\n'));
}

function runCrawler() {
  const startTime = new Date();
  const attempt = retryCount + 1;
  const logPrefix = `[Attempt ${attempt}/${MAX_RETRIES}]`;
  
  console.log(`${logPrefix} 开始执行爬虫 (${startTime.toLocaleTimeString()})...`);
  
  const captureMaxChars = Number(process.env.RUNNER_CAPTURE_MAX_CHARS || 2000000);
  const dumpTailChars = Number(process.env.RUNNER_DUMP_TAIL_CHARS || 6000);
  let stdout = '';
  let stderr = '';
  let killed = false;
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'runner.js')],
    { cwd: __dirname, env: process.env, windowsHide: true }
  );
  const killTimer = setTimeout(() => {
    killed = true;
    try {
      child.kill();
    } catch {}
  }, EXEC_TIMEOUT);

  child.stdout.on('data', (data) => {
    const s = String(data || '');
    stdout = appendTail(stdout, s, captureMaxChars);
    process.stdout.write(s);
  });
  child.stderr.on('data', (data) => {
    const s = String(data || '');
    stderr = appendTail(stderr, s, captureMaxChars);
    process.stderr.write(s);
  });

  child.on('close', (code) => {
    clearTimeout(killTimer);
    const error = killed || code ? new Error(killed ? 'Timeout' : `Exit code: ${code}`) : null;
    if (error && killed) error.killed = true;
    const endTime = new Date();
    const elapsed = ((endTime - startTime) / 1000).toFixed(1);
      
      // 记录执行结果
      console.log(`${logPrefix} 执行完成 (耗时: ${elapsed}秒)`);
      const outTail = (stdout || '').slice(-Math.max(0, dumpTailChars)).trim();
      const errTail = (stderr || '').slice(-Math.max(0, dumpTailChars)).trim();
      console.log(`${logPrefix} stdoutTail >>\n${outTail || '无输出'}\n<<`);
      if (errTail) console.error(`${logPrefix} stderrTail >>\n${errTail}\n<<`);

      // 检查超时
      if (error && error.killed) {
        console.error(`${logPrefix} 超时中止: 执行超过${EXEC_TIMEOUT/60000}分钟`);
      } 
      // 其他错误处理
      else if (error) {
        console.error(`${logPrefix} 执行错误:`, error.message);
      }

      // 关键诊断信息
      const successDetected = stdout.includes(SUCCESS_FLAG);
      console.log(`${logPrefix} 成功标志检测: ` + 
                  (successDetected ? '✔ 找到' : '✖ 未找到'));

      // 成功时退出
      if (successDetected) {
        console.log(`${logPrefix} 爬取成功！`);
        (async () => {
          const externUserSize = getExternUserFileSizeForNotice();
          const totalStockMatch = stdout.match(/Total stock count:\s*(\d+)/);
          const totalStockCount = totalStockMatch ? totalStockMatch[1] : '未知';
          const lineCountMatch = stdout.match(/Line count:\s*(\d+)/);
          const lineCount = lineCountMatch ? lineCountMatch[1] : '未知';
          const llmAlertSummary = getLlmAlertSummaryForNotice(stdout, stderr);
          const annMerge = parseAnnMergeStatsFromStdout(stdout);
          const shouldSkipKimi = annMerge && annMerge.added === 0 && annMerge.updated === 0;
          if (shouldSkipKimi) {
            console.log(`Kimi精选跳过：公告无新增/更新（new=0 updated=0 total=${annMerge.total} unchanged=${annMerge.unchanged}）`);
          }
          const cachedKimi = loadKimiDigestCache();
          const cachedSel = loadKimiSelectionCache();
          let kimiDigest = '';
          if (shouldSkipKimi) {
            kimiDigest = cachedKimi;
            if (!kimiDigest) {
              kimiDigest = (await getAnnouncementDigestByKimi()) || '';
            }
          } else {
            kimiDigest = (await getAnnouncementDigestByKimi()) || cachedKimi;
          }
          let kimiSel = null;
          if (shouldSkipKimi) {
            kimiSel = cachedSel;
            if (!kimiSel) kimiSel = await getKimiSelectionByKimi();
          } else {
            kimiSel = (await getKimiSelectionByKimi()) || cachedSel;
          }
          const nameMap = loadStockNameMap();
          const annSummary = injectStockNamesIntoKimiSection(kimiDigest || getAnnouncementSummaryForNotice(), nameMap);
          const wecomKimi = formatKimiSelectionMessage(kimiSel);
          const wecomContent = buildWeComNotice({ kimiSelectionText: wecomKimi, kimiDigestMarkdown: annSummary });
          const successMessage = [
            `### ✅ 爬虫任务成功执行`,
            `**尝试次数**: ${attempt}/${MAX_RETRIES}`,
            `**开始时间**: ${startTime.toLocaleString()}`,
            `**结束时间**: ${endTime.toLocaleString()}`,
            `**执行耗时**: ${elapsed}秒`,
            `**股票总数**: ${totalStockCount}`,
            `**输出行数**: ${lineCount}`,
            `**extern_user.txt 大小**: ${externUserSize}`,
            `**输出摘要**: ${stdout.trim().slice(-100)}`,
            llmAlertSummary,
            annSummary
          ].filter(Boolean).join('\n\n');
          console.log(`\n===== Server酱通知内容（预览）=====\n${successMessage}\n===== 结束 =====\n`);
          if (EMAIL_MONITOR_ADDR && EMAIL_MONITOR_AUTH) {
            console.log('EmailMonitor 配置已检测到（当前仅使用企业微信 Webhook 推送）');
          }
          await sendWeComMarkdown(wecomContent);
          sendServerChan(successMessage).finally(() => process.exit(0));
        })().catch((e) => {
          console.error('Build notice failed:', e && e.message ? e.message : e);
          const fallbackMessage = `### ✅ 爬虫任务成功执行\n\n但构建通知失败：${e && e.message ? e.message : e}`;
          console.log(`\n===== Server酱通知内容（预览）=====\n${fallbackMessage}\n===== 结束 =====\n`);
          sendServerChan(fallbackMessage).finally(() => process.exit(0));
        });
        return;
      }

      // 重试逻辑
      if (attempt < MAX_RETRIES) {
        retryCount++;
        console.log([
          `${logPrefix} 准备重试...`,
          `剩余尝试: ${MAX_RETRIES - attempt}次`,
          `下次执行: ${new Date(Date.now() + RETRY_INTERVAL).toLocaleTimeString()}`
        ].join('\n'));
        
        setTimeout(runCrawler, RETRY_INTERVAL);
      } 
      // 终止条件
      else {
        const externUserSize = getExternUserFileSizeForNotice();
        const totalStockMatch = stdout.match(/Total stock count:\s*(\d+)/);
        const totalStockCount = totalStockMatch ? totalStockMatch[1] : '未知';
        const lineCountMatch = stdout.match(/Line count:\s*(\d+)/);
        const lineCount = lineCountMatch ? lineCountMatch[1] : '未知';
        const errorMessage = [
          `## ❌ 爬虫任务失败`,
          `已达最大重试次数 (${MAX_RETRIES})`,
          `**股票总数**: ${totalStockCount}`,
          `**输出行数**: ${lineCount}`,
          `**extern_user.txt 大小**: ${externUserSize}`
        ].join('\n\n');
        console.log(`\n===== Server酱通知内容（预览）=====\n${errorMessage}\n===== 结束 =====\n`);
        sendServerChan(errorMessage).finally(() => {
          console.error(`[中止] 达到最大重试次数 (${MAX_RETRIES}) 仍未成功`);
          console.error('最后输出:', stdout.trim().slice(-500) || '无输出');
          process.exit(1);
        });
      }
  });
}

module.exports = {
  loadStockNameMap,
  injectStockNamesIntoKimiSection,
  buildServerChanRequest,
  formatKimiSelectionMessage,
  normalizeKimiSelection
};

if (require.main === module) {
  console.log(`== 爬虫监控启动 ==`);
  console.log(`配置: ${MAX_RETRIES}次重试/每次间隔${RETRY_INTERVAL/1000}秒`);
  runCrawler();
}
