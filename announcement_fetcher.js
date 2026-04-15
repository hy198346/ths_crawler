const fs = require('fs');
const path = require('path');
const tunnel = require('tunnel');
const zlib = require('zlib');
let pdfParse = null;
try {
    pdfParse = require('pdf-parse');
} catch {}

const CNINFO_PAGE_SIZE = Number(process.env.CNINFO_PAGE_SIZE || 50);
const CNINFO_MAX_PAGES = Number(process.env.CNINFO_MAX_PAGES || 400);
const CNINFO_TIMEOUT_MS = Number(process.env.CNINFO_TIMEOUT_MS || 20000);
const CNINFO_STALL_PAGES = Number(process.env.CNINFO_STALL_PAGES || 2);
const ANNOUNCEMENT_SUMMARY_CHARS = Number(process.env.ANNOUNCEMENT_SUMMARY_CHARS || 200);
const ANNOUNCEMENT_SUMMARY_CONCURRENCY = Number(process.env.ANNOUNCEMENT_SUMMARY_CONCURRENCY || 3);
const ANNOUNCEMENT_MAX_PER_STOCK_DAY = Number(process.env.ANNOUNCEMENT_MAX_PER_STOCK_DAY || 10);
const ANNOUNCEMENT_MAX_PER_STOCK_RANGE = Number(process.env.ANNOUNCEMENT_MAX_PER_STOCK_RANGE || ANNOUNCEMENT_MAX_PER_STOCK_DAY * 2);
const ANNOUNCEMENT_PDF_CONCURRENCY = Number(process.env.ANNOUNCEMENT_PDF_CONCURRENCY || 2);
const ANNOUNCEMENT_PDF_MAX_CHARS = Number(process.env.ANNOUNCEMENT_PDF_MAX_CHARS || 8000);
const ANNOUNCEMENT_PDF_MAX_BYTES = Number(process.env.ANNOUNCEMENT_PDF_MAX_BYTES || 8000000);
const LLM_MODEL = process.env.KIMI_MODEL || process.env.LLM_MODEL || 'moonshot-v1-8k';
const LLM_BASE_URL = (process.env.KIMI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.KIMI_API_KEY || process.env.LLM_API_KEY || '';
const LLM_DEBUG = ['1', 'true', 'yes', 'on'].includes(String(process.env.KIMI_DEBUG || process.env.LLM_DEBUG || '').trim().toLowerCase());
const CNINFO_TZ = process.env.CNINFO_TZ || 'Asia/Shanghai';
const ANN_OUTPUT_PATH = process.env.ANN_OUTPUT_PATH || path.join(__dirname, 'extern_user_ann.txt');
const STOCK_LIST_PATH = process.env.STOCK_LIST_PATH || path.join(__dirname, 'stock_list.json');

let tunnelHttpsAgent = null;
let tunnelHttpAgent = null;
let loggedProxy = false;
let llmFailCnt = 0;
let llmUsedCnt = 0;
let llmFallbackCnt = 0;
let llmSameAsTitleCnt = 0;
let cninfoFailCnt = 0;

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

function getAgentForUrl(targetUrl) {
    const proxy = getTunnelProxyConfig();
    if (!proxy) return undefined;
    if (!loggedProxy) {
        loggedProxy = true;
        console.log(`ANN Proxy enabled: ${proxy.host}:${proxy.port}`);
    }
    if (targetUrl.protocol === 'https:') {
        if (!tunnelHttpsAgent) {
            tunnelHttpsAgent = tunnel.httpsOverHttp({ proxy, maxSockets: 200 });
        }
        return tunnelHttpsAgent;
    }
    if (targetUrl.protocol === 'http:') {
        if (!tunnelHttpAgent) {
            tunnelHttpAgent = tunnel.httpOverHttp({ proxy, maxSockets: 200 });
        }
        return tunnelHttpAgent;
    }
    return undefined;
}

function cninfoDateString(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const dtf = new Intl.DateTimeFormat('en-CA', {
        timeZone: CNINFO_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    });
    return dtf.format(d);
}

function cleanOneLine(s) {
    return String(s || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
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

function cninfoEpochMs(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : (v > 1e10 ? v * 1000 : v);
    const s = String(v).trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
        const n = Number(s);
        if (!Number.isFinite(n)) return null;
        return n > 1e12 ? n : (n > 1e10 ? n * 1000 : n);
    }
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : null;
}

function buildPdfUrl(adjunctUrl) {
    const u0 = String(adjunctUrl || '').trim();
    if (!u0) return '';
    if (u0.startsWith('http://') || u0.startsWith('https://')) return u0;
    const u = u0.startsWith('/') ? u0 : `/${u0}`;
    return `https://static.cninfo.com.cn${u}`;
}

async function fetchAnnouncementPdfText(ann) {
    if (!pdfParse) return '';
    const pdfUrl = buildPdfUrl(ann && ann.adjunctUrl ? ann.adjunctUrl : '');
    if (!pdfUrl) return '';
    try {
        const res = await requestBuffer(new URL(pdfUrl), {
            method: 'GET',
            headers: { 'Accept-Encoding': 'identity' },
            timeoutMs: CNINFO_TIMEOUT_MS
        });
        const buf = res && res.buf ? res.buf : null;
        if (!buf || !buf.length) return '';
        if (ANNOUNCEMENT_PDF_MAX_BYTES > 0 && buf.length > ANNOUNCEMENT_PDF_MAX_BYTES) return '';
        const parsed = await pdfParse(buf);
        const text = parsed && parsed.text ? String(parsed.text) : '';
        let s = text.replace(/\s+/g, ' ').trim();
        if (ANNOUNCEMENT_PDF_MAX_CHARS > 0 && s.length > ANNOUNCEMENT_PDF_MAX_CHARS) {
            s = s.slice(0, ANNOUNCEMENT_PDF_MAX_CHARS);
        }
        return s;
    } catch (e) {
        return '';
    }
}

function formatCninfoTime(v) {
    if (v === null || v === undefined) return '';
    let ts = null;
    if (typeof v === 'number' && Number.isFinite(v)) {
        ts = v;
    } else {
        const s = String(v).trim();
        if (!s) return '';
        if (/^\d+$/.test(s)) ts = Number(s);
        else {
            const parsed = Date.parse(s);
            if (Number.isFinite(parsed)) ts = parsed;
        }
    }
    if (!Number.isFinite(ts)) return String(v);
    if (ts > 1e12) ts = Math.floor(ts);
    if (ts > 1e11) ts = Math.floor(ts / 1000);
    const d = new Date(ts * 1000);
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: CNINFO_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(d);
    const m = Object.create(null);
    for (const p of parts) {
        if (p.type !== 'literal') m[p.type] = p.value;
    }
    return `${m.year}-${m.month}-${m.day} ${m.hour}:${m.minute}:${m.second}`;
}

function requestBuffer(targetUrl, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
    const http = require('http');
    const https = require('https');
    const { Buffer } = require('buffer');
    const isHttps = targetUrl.protocol === 'https:';
    const client = isHttps ? https : http;
    const agent = getAgentForUrl(targetUrl);
    return new Promise((resolve, reject) => {
        const req = client.request(
            {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                path: `${targetUrl.pathname}${targetUrl.search}`,
                method,
                headers,
                agent,
                timeout: timeoutMs
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    let buf = Buffer.concat(chunks);
                    const encRaw = res.headers && res.headers['content-encoding'] ? String(res.headers['content-encoding']) : '';
                    const enc = encRaw.toLowerCase();
                    try {
                        if (enc.includes('gzip')) buf = zlib.gunzipSync(buf);
                        else if (enc.includes('br') && typeof zlib.brotliDecompressSync === 'function') buf = zlib.brotliDecompressSync(buf);
                        else if (enc.includes('deflate')) buf = zlib.inflateSync(buf);
                    } catch (e) {
                        const err = new Error(`Decompress failed: ${encRaw || 'unknown'}`);
                        err.statusCode = res.statusCode;
                        err.inner = e && e.message ? e.message : e;
                        return reject(err);
                    }
                    if (res.statusCode !== 200) {
                        const err = new Error(`Status code: ${res.statusCode}`);
                        err.statusCode = res.statusCode;
                        err.body = buf.toString();
                        return reject(err);
                    }
                    resolve({ buf, headers: res.headers || {} });
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

async function cninfoQuery({ seDate, pageNum, pageSize }) {
    const url = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Origin': 'https://www.cninfo.com.cn',
        'Referer': 'https://www.cninfo.com.cn/',
        'X-Requested-With': 'XMLHttpRequest'
    };
    const data = new URLSearchParams({
        pageNum: String(pageNum),
        pageSize: String(pageSize),
        column: 'szse',
        tabName: 'fulltext',
        plate: '',
        stock: '',
        searchkey: '',
        secid: '',
        category: '',
        trade: '',
        seDate: String(seDate || ''),
        sortName: 'time',
        sortType: 'desc',
        isHLtitle: 'true'
    });
    const body = data.toString();
    const res = await requestBuffer(new URL(url), {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        body,
        timeoutMs: CNINFO_TIMEOUT_MS
    });
    const text = res.buf.toString();
    let j;
    try {
        j = JSON.parse(text);
    } catch {
        j = null;
    }
    if (!j || typeof j !== 'object') {
        const err = new Error('CNINFO invalid JSON');
        err.body = text.slice(0, 800);
        const ct = res.headers && res.headers['content-type'] ? String(res.headers['content-type']) : '';
        const ce = res.headers && res.headers['content-encoding'] ? String(res.headers['content-encoding']) : '';
        err.meta = `content-type=${ct} content-encoding=${ce}`;
        throw err;
    }
    return j;
}

async function cninfoDailyByStock(dateStr) {
    const seDate = `${dateStr}~${dateStr}`;
    const out = new Map();
    const seenAnn = new Set();
    const maxPages = Number.isFinite(CNINFO_MAX_PAGES) && CNINFO_MAX_PAGES > 0 ? CNINFO_MAX_PAGES : 1;
    const pageSize = Number.isFinite(CNINFO_PAGE_SIZE) && CNINFO_PAGE_SIZE > 0 ? CNINFO_PAGE_SIZE : 50;
    const stallLimit = Number.isFinite(CNINFO_STALL_PAGES) && CNINFO_STALL_PAGES > 0 ? Math.floor(CNINFO_STALL_PAGES) : 0;
    let stallCount = 0;

    for (let page = 1; page <= maxPages; page += 1) {
        let j;
        try {
            console.log(`ANN CNINFO query: date=${dateStr} page=${page}/${maxPages} pageSize=${pageSize}`);
            j = await cninfoQuery({ seDate, pageNum: page, pageSize });
        } catch (e) {
            cninfoFailCnt++;
            console.warn(`CNINFO daily query failed: ${dateStr} page=${page} err=${e && e.message ? e.message : e}`);
            break;
        }
        const items = j && Array.isArray(j.announcements) ? j.announcements : null;
        if (!items || items.length === 0) {
            console.log(`ANN CNINFO empty: date=${dateStr} page=${page}`);
            break;
        }
        console.log(`ANN CNINFO items: date=${dateStr} page=${page} items=${items.length}`);
        let addedNewStock = 0;
        let addedNewAnn = 0;
        for (const item of items) {
            const secCode = String(item.secCode || item.sec_code || '').trim();
            if (!secCode) continue;
            const announcementId = String(item.announcementId || item.announcement_id || '').trim();
            if (announcementId && seenAnn.has(announcementId)) continue;
            if (announcementId) seenAnn.add(announcementId);
            const epochMs = cninfoEpochMs(item.announcementTime || item.announcement_time || '') || 0;
            const title = String(item.announcementTitle || item.announcement_title || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
            const adjunctUrl = String(item.adjunctUrl || item.adjunct_url || '').trim();
            const timeStr = formatCninfoTime(item.announcementTime || item.announcement_time || '');
            let entry = out.get(secCode);
            if (!entry) {
                entry = {
                    secCode,
                    secName: String(item.secName || item.sec_name || '').trim(),
                    latestEpochMs: epochMs,
                    latestTime: timeStr,
                    announcements: []
                };
                out.set(secCode, entry);
                addedNewStock++;
            }
            if (entry.announcements.length < ANNOUNCEMENT_MAX_PER_STOCK_DAY) {
                entry.announcements.push({
                    announcementId,
                    title,
                    time: timeStr,
                    epochMs,
                    adjunctUrl
                });
                addedNewAnn++;
            }
            if (epochMs > (entry.latestEpochMs || 0)) {
                entry.latestEpochMs = epochMs;
                entry.latestTime = timeStr;
            }
        }
        console.log(`ANN CNINFO unique: date=${dateStr} uniqueStocks=${out.size}`);
        if (addedNewStock === 0 && addedNewAnn === 0) {
            stallCount += 1;
        } else {
            stallCount = 0;
        }
        if (stallLimit && stallCount >= stallLimit) {
            console.log(`ANN CNINFO stop on stall: date=${dateStr} stallPages=${stallCount}`);
            break;
        }
    }
    return out;
}

async function cninfoPickDayForTodayAndYesterday() {
    const today = cninfoDateString(0);
    const yesterday = cninfoDateString(-1);
    const todayMap = await cninfoDailyByStock(today);
    const yMap = await cninfoDailyByStock(yesterday);
    const merged = new Map();
    for (const [k, v] of todayMap.entries()) merged.set(k, v);
    for (const [k, v] of yMap.entries()) {
        const cur = merged.get(k);
        if (!cur) {
            merged.set(k, v);
            continue;
        }
        const combined = []
            .concat(Array.isArray(cur.announcements) ? cur.announcements : [])
            .concat(Array.isArray(v.announcements) ? v.announcements : []);
        const uniq = [];
        const seen = new Set();
        for (const a of combined) {
            const id = a && a.announcementId ? String(a.announcementId) : '';
            const key = id ? `id:${id}` : `t:${String(a && a.time ? a.time : '')}|${String(a && a.title ? a.title : '')}`;
            if (seen.has(key)) continue;
            seen.add(key);
            uniq.push(a);
        }
        uniq.sort((a, b) => (Number(b && b.epochMs ? b.epochMs : 0) || 0) - (Number(a && a.epochMs ? a.epochMs : 0) || 0));
        const cap = Number.isFinite(ANNOUNCEMENT_MAX_PER_STOCK_RANGE) && ANNOUNCEMENT_MAX_PER_STOCK_RANGE > 0
            ? Math.floor(ANNOUNCEMENT_MAX_PER_STOCK_RANGE)
            : 0;
        cur.announcements = cap ? uniq.slice(0, cap) : uniq;
        if ((v.latestEpochMs || 0) > (cur.latestEpochMs || 0)) {
            cur.latestEpochMs = v.latestEpochMs || 0;
            cur.latestTime = v.latestTime || '';
        }
        if (!cur.secName && v.secName) cur.secName = v.secName;
    }
    return merged;
}

async function llmSummarizeAnnouncement({ secCode, secName, announcementTime, announcementTitle }, maxChars, rawText = '') {
    const fallback = cutByChars(announcementTitle || '', maxChars);
    if (!LLM_API_KEY) {
        llmDebugLog(`ANN LLM off: missing apiKey sec=${secCode || ''}`);
        llmFallbackCnt++;
        return fallback;
    }
    const titleOneLine = cleanOneLine(announcementTitle || '');
    const payload = cleanOneLine(rawText || '') || titleOneLine;
    const basePrompt = `请将以下公告正文“通读后”合并输出为一条不超过${maxChars}个汉字的“内容要点”（尽量贴近原文措辞，不要推测/编造）。优先抽取并保留明确的事实信息（事项/金额/数量/比例/对象/时间/业绩数据/增减持数量与期限/会议决议/风险提示等），数字与单位尽量原样保留。只输出内容要点，不要标题，不要换行。若包含多份公告正文（例如多段以【标题】开头），请按时间顺序合并为一段：股票:${secCode} 名称:${secName} 时间:${announcementTime} 标题:${titleOneLine} 正文:${payload}`;
    const url = `${LLM_BASE_URL}/chat/completions`;
    try {
        const callOnce = async (prompt) => {
            const t0 = Date.now();
            const body = JSON.stringify({
                model: LLM_MODEL,
                messages: [
                    { role: 'system', content: '你是严谨的中文财报/公告摘要助手。' },
                    { role: 'user', content: prompt }
                ],
                temperature: 0.2
            });
            llmDebugLog(
                `ANN LLM req: sec=${secCode || ''} model=${LLM_MODEL} host=${new URL(url).host} promptChars=${String(prompt || '').length} bodyBytes=${Buffer.byteLength(body)}`
            );
            const res = await requestBuffer(new URL(url), {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${LLM_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                },
                body,
                timeoutMs: Math.max(CNINFO_TIMEOUT_MS, 20000)
            });
            const text = res.buf.toString();
            let j;
            try {
                j = JSON.parse(text);
            } catch {
                j = null;
            }
            const tookMs = Date.now() - t0;
            const ct = res.headers && res.headers['content-type'] ? String(res.headers['content-type']) : '';
            llmDebugLog(
                `ANN LLM res: sec=${secCode || ''} ms=${tookMs} bytes=${res.buf.length} contentType=${ct || 'unknown'} json=${j ? 'ok' : 'fail'}`
            );
            if (!j) {
                llmDebugLog(`ANN LLM resHead: ${cutByChars(text, 220)}`);
            }
            const content = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
            const out = cutByChars(content || '', maxChars);
            llmDebugLog(`ANN LLM out: sec=${secCode || ''} outChars=${out.length} fallback=${out ? 'no' : 'yes'}`);
            return out;
        };

        llmUsedCnt++;
        const first = await callOnce(basePrompt);
        if (!first) {
            llmDebugLog(`ANN LLM empty: sec=${secCode || ''} fallback=title`);
            llmFallbackCnt++;
            return fallback;
        }
        const firstNorm = cleanOneLine(first);
        const titleNorm = titleOneLine;
        if (titleNorm && firstNorm && (firstNorm === titleNorm || firstNorm.replace(/[。.!！?？]/g, '') === titleNorm.replace(/[。.!！?？]/g, ''))) {
            llmSameAsTitleCnt++;
            llmDebugLog(`ANN LLM retry: sec=${secCode || ''} reason=sameAsTitle titleChars=${titleNorm.length} outChars=${firstNorm.length}`);
            const retryPrompt = `不要照抄标题。请尽量从正文提取“内容要点”（贴近原文措辞，保留数字与单位，不要推测/编造），不超过${maxChars}个汉字，只输出一段，不要换行。若正文不足以提取，请输出“正文不足，建议查看公告全文”：股票:${secCode} 名称:${secName} 时间:${announcementTime} 标题:${titleNorm} 正文:${payload}`;
            const second = await callOnce(retryPrompt);
            if (second) return cleanOneLine(second);
        }
        return firstNorm;
    } catch (e) {
        llmFailCnt++;
        const sc = e && e.statusCode ? String(e.statusCode) : '';
        console.warn(`LLM summarize failed: ${secCode} status=${sc || 'na'} err=${e && e.message ? e.message : e}`);
        llmDebugLog(`ANN LLM fail: sec=${secCode || ''} used=${llmUsedCnt} fail=${llmFailCnt} fallback=${llmFallbackCnt}`);
        llmFallbackCnt++;
        return fallback;
    }
}

async function summarizeWithConcurrency(items, limit, fn) {
    const arr = Array.isArray(items) ? items : [];
    const c = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 1;
    const out = new Array(arr.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(c, arr.length || 1) }, () =>
        (async () => {
            while (true) {
                const i = idx;
                idx += 1;
                if (i >= arr.length) return;
                out[i] = await fn(arr[i], i);
            }
        })()
    );
    await Promise.all(workers);
    return out;
}

function loadExchangeIdMap() {
    try {
        const raw = fs.readFileSync(STOCK_LIST_PATH, 'utf8');
        const j = JSON.parse(raw);
        const stocks = j && Array.isArray(j.stocks) ? j.stocks : [];
        const map = new Map();
        for (const s of stocks) {
            const id = s && s.f12 ? String(s.f12) : '';
            if (!id) continue;
            let ex = s && (s.f13 === 0 || s.f13 === 1 || s.f13 === 2 || s.f13 === 9 || s.f13 === 4 || s.f13 === 8)
                ? String(s.f13)
                : (s && s.f13 !== undefined ? String(s.f13) : '');
            if (id.startsWith('8') || id.startsWith('4') || id.startsWith('9')) ex = '2';
            if (!ex) continue;
            map.set(id, ex);
        }
        return map;
    } catch {
        return new Map();
    }
}

function fallbackExchangeId(stockId) {
    const id = String(stockId || '');
    if (id.startsWith('8') || id.startsWith('4') || id.startsWith('9')) return '2';
    if (id.startsWith('6')) return '1';
    return '0';
}

async function main() {
    console.log(`ANN Start: out=${ANN_OUTPUT_PATH}`);
    console.log(`ANN Config: tz=${CNINFO_TZ} pageSize=${CNINFO_PAGE_SIZE} maxPages=${CNINFO_MAX_PAGES} stallPages=${CNINFO_STALL_PAGES} timeoutMs=${CNINFO_TIMEOUT_MS}`);
    console.log(`ANN Summary: chars=${ANNOUNCEMENT_SUMMARY_CHARS} conc=${ANNOUNCEMENT_SUMMARY_CONCURRENCY} llm=${LLM_API_KEY ? 'on' : 'off'} model=${LLM_MODEL} base=${LLM_BASE_URL}`);
    console.log(`ANN PDF: parser=${pdfParse ? 'on' : 'off'} maxPerStockDay=${ANNOUNCEMENT_MAX_PER_STOCK_DAY} maxPerStockRange=${ANNOUNCEMENT_MAX_PER_STOCK_RANGE} pdfConc=${ANNOUNCEMENT_PDF_CONCURRENCY} pdfMaxChars=${ANNOUNCEMENT_PDF_MAX_CHARS}`);
    const proxy = getTunnelProxyConfig();
    console.log(`ANN Proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'off'}`);
    const exchangeMap = loadExchangeIdMap();
    console.log(`ANN Stock list: path=${STOCK_LIST_PATH} size=${exchangeMap.size}`);
    const today = cninfoDateString(0);
    const yesterday = cninfoDateString(-1);
    console.log(`ANN Dates: today=${today} yesterday=${yesterday}`);
    const merged = await cninfoPickDayForTodayAndYesterday();
    const annList = Array.from(merged.values());
    console.log(`ANN Latest unique stocks: ${annList.length}`);

    const summaries = await summarizeWithConcurrency(
        annList,
        ANNOUNCEMENT_SUMMARY_CONCURRENCY,
        async (entry) => {
            const secCode = entry && entry.secCode ? String(entry.secCode) : '';
            const secName = entry && entry.secName ? String(entry.secName) : '';
            const announcementTime = entry && entry.latestTime ? String(entry.latestTime) : '';
            const anns = entry && Array.isArray(entry.announcements) ? entry.announcements : [];
            llmDebugLog(`ANN Summarize: sec=${secCode || ''} anns=${anns.length} pdf=${LLM_API_KEY && pdfParse ? 'on' : 'off'}`);
            const titles = anns.map((a) => cleanOneLine(a.title || '')).filter(Boolean);
            const titleJoined = titles.join('；');

            const payloadTitle = titleJoined || (titles[0] || '');
            if (!LLM_API_KEY || !pdfParse) {
                return llmSummarizeAnnouncement(
                    { secCode, secName, announcementTime, announcementTitle: payloadTitle },
                    ANNOUNCEMENT_SUMMARY_CHARS,
                    payloadTitle
                );
            }

            const pdfTexts = await summarizeWithConcurrency(
                anns,
                ANNOUNCEMENT_PDF_CONCURRENCY,
                async (a) => fetchAnnouncementPdfText(a)
            );
            const bodyBlocks = [];
            for (let i = 0; i < anns.length; i += 1) {
                const a = anns[i];
                const t = cleanOneLine(a && a.title ? a.title : '');
                const body = cleanOneLine(pdfTexts[i] || '');
                if (!t && !body) continue;
                bodyBlocks.push(`【${t}】${body}`);
            }
            const payloadText = bodyBlocks.length ? bodyBlocks.join(' ') : payloadTitle;
            return llmSummarizeAnnouncement(
                { secCode, secName, announcementTime, announcementTitle: payloadTitle },
                ANNOUNCEMENT_SUMMARY_CHARS,
                payloadText
            );
        }
    );
    const lines = [];
    let cnt = 0;
    for (let i = 0; i < annList.length; i += 1) {
        const ann = annList[i];
        const stockId = ann && ann.secCode ? String(ann.secCode) : '';
        if (!stockId) continue;
        const exchangeId = exchangeMap.get(stockId) || fallbackExchangeId(stockId);
        const t = cleanOneLine(ann.latestTime || '');
        const s = cleanOneLine(summaries[i] || '');
        if (!t || !s) continue;
        lines.push(`${exchangeId}|${stockId}|22|${t} ${s}|0.000`);
        cnt++;
    }
    fs.writeFileSync(ANN_OUTPUT_PATH, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    console.log(`公告家数: ${cnt}`);
    console.log(`ANN Done: written=${cnt} cninfoFail=${cninfoFailCnt} llmUsed=${llmUsedCnt} llmSameAsTitle=${llmSameAsTitleCnt} llmFallback=${llmFallbackCnt} llmFail=${llmFailCnt}`);
}

main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
});
