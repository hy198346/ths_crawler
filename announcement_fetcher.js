const fs = require('fs');
const path = require('path');
const tunnel = require('tunnel');
const zlib = require('zlib');
let pdfParse = null;
try {
    pdfParse = require('pdf-parse');
} catch {}

const CNINFO_PAGE_SIZE = Number(process.env.CNINFO_PAGE_SIZE || 50);
const CNINFO_MAX_PAGES = Number(process.env.CNINFO_MAX_PAGES || 300);
const CNINFO_TIMEOUT_MS = Number(process.env.CNINFO_TIMEOUT_MS || 20000);
const CNINFO_STALL_PAGES = Number(process.env.CNINFO_STALL_PAGES || 2);
const CNINFO_LOG_EVERY_PAGES = Number(process.env.CNINFO_LOG_EVERY_PAGES || 10);
const CNINFO_PLATES = String(process.env.CNINFO_PLATES || 'all')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const CNINFO_QUERIES = [];
for (const plate of (CNINFO_PLATES && CNINFO_PLATES.length ? CNINFO_PLATES : ['sz'])) {
    const p = String(plate || '').trim();
    const isAll = p === 'all' || p === '*' || p === 'full' || p === 'both';
    const column = isAll ? '' : (p === 'sh' ? 'sse' : 'szse');
    const plateArg = isAll ? '' : p;
    CNINFO_QUERIES.push({ plate: plateArg, column });
    CNINFO_QUERIES.push({ plate: plateArg, column, category: 'category_yjdbg_szsh' });
}
const ANNOUNCEMENT_SUMMARY_CHARS = Number(process.env.ANNOUNCEMENT_SUMMARY_CHARS || 100);
const ANNOUNCEMENT_SUMMARY_CONCURRENCY = Number(process.env.ANNOUNCEMENT_SUMMARY_CONCURRENCY || 3);
const ANNOUNCEMENT_MAX_PER_STOCK_DAY = Number(process.env.ANNOUNCEMENT_MAX_PER_STOCK_DAY || 10);
const ANNOUNCEMENT_MAX_PER_STOCK_RANGE = Number(process.env.ANNOUNCEMENT_MAX_PER_STOCK_RANGE || ANNOUNCEMENT_MAX_PER_STOCK_DAY * 2);
const ANNOUNCEMENT_PDF_CONCURRENCY = Number(process.env.ANNOUNCEMENT_PDF_CONCURRENCY || 2);
const ANNOUNCEMENT_PDF_MAX_CHARS = Number(process.env.ANNOUNCEMENT_PDF_MAX_CHARS || 8000);
const ANNOUNCEMENT_PDF_MAX_BYTES = Number(process.env.ANNOUNCEMENT_PDF_MAX_BYTES || 8000000);
const LLM_MODEL = process.env.KIMI_MODEL || process.env.LLM_MODEL || 'kimi-k2-turbo-preview';
const LLM_BASE_URL = (process.env.KIMI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.KIMI_API_KEY || process.env.LLM_API_KEY || '';
const LLM_DEBUG = ['1', 'true', 'yes', 'on'].includes(String(process.env.KIMI_DEBUG || process.env.LLM_DEBUG || '').trim().toLowerCase());
const CNINFO_TZ = process.env.CNINFO_TZ || 'Asia/Shanghai';
const ANN_USE_TUNNEL_PROXY = ['1', 'true', 'yes', 'on'].includes(String(process.env.ANN_USE_TUNNEL_PROXY || '').trim().toLowerCase());
const ANN_TIME_FORMAT = String(process.env.ANN_TIME_FORMAT || '').trim().toLowerCase();
const ANN_DECIMAL_DIGITS = Number(process.env.ANN_DECIMAL_DIGITS || 2);
const ANN_OUTPUT_PATH = process.env.ANN_OUTPUT_PATH || path.join(__dirname, 'extern_user_ann.txt');
const ANN_SUMMARY_CACHE_PATH = process.env.ANN_SUMMARY_CACHE_PATH || path.join(__dirname, 'extern_user_ann_cache.json');
const ANN_PRINT_UPDATED = ['1', 'true', 'yes', 'on'].includes(String(process.env.ANN_PRINT_UPDATED || '').trim().toLowerCase());
const ANN_PRINT_UPDATED_LIMIT = Number(process.env.ANN_PRINT_UPDATED_LIMIT || 50);
const ANN_RUN_TIMES = Number(process.env.ANN_RUN_TIMES || 3);
const STOCK_LIST_PATH = process.env.STOCK_LIST_PATH || path.join(__dirname, 'stock_list.json');
const STOCK_CODES_PATH = process.env.STOCK_CODES_PATH
    ? path.resolve(process.env.STOCK_CODES_PATH)
    : path.join(__dirname, 'stock_codes.txt');
const ANN_UPDATE_WINDOW_HOURS = Number(process.env.ANN_UPDATE_WINDOW_HOURS || 0);
const ANN_LOOKBACK_DAYS = Number(process.env.ANN_LOOKBACK_DAYS || 2);

let tunnelHttpsAgent = null;
let tunnelHttpAgent = null;
let loggedProxy = false;
let llmFailCnt = 0;
let llmUsedCnt = 0;
let llmFallbackCnt = 0;
let llmSameAsTitleCnt = 0;
let cninfoFailCnt = 0;
let llmMissingApiKeyNoted = false;
let llmPdfParserMissingNoted = false;
const llmErrorLines = [];

function getTunnelProxyConfig() {
    if (!ANN_USE_TUNNEL_PROXY) return null;
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

function annStableKey(a) {
    const id = a && a.announcementId ? String(a.announcementId) : '';
    if (id) return `id:${id}`;
    const epochMs = Number(a && a.epochMs ? a.epochMs : 0) || 0;
    const adjunctUrl = a && a.adjunctUrl ? String(a.adjunctUrl) : '';
    const title = cleanOneLine(a && a.title ? a.title : '');
    return `k:${epochMs}|${adjunctUrl}|${title}`;
}

function buildCacheKey(anns) {
    const arr = Array.isArray(anns) ? anns : [];
    const parts = arr.map((a) => annStableKey(a)).filter(Boolean);
    parts.sort();
    return `n:${parts.length}|${parts.join(',')}`;
}

function buildTitleKey(anns) {
    const arr = Array.isArray(anns) ? anns : [];
    const uniq = new Set();
    for (const a of arr) {
        const t = cleanOneLine(a && a.title ? a.title : '');
        if (t) uniq.add(t);
    }
    const titles = Array.from(uniq);
    titles.sort();
    return `n:${titles.length}|${titles.join('；')}`;
}

function normalizeTitleKey(s) {
    const raw = cleanOneLine(s || '');
    if (!raw) return '';
    const tail = raw.startsWith('n:') ? raw.slice(2) : raw;
    const pipe = tail.indexOf('|');
    const titlesPart = pipe >= 0 ? tail.slice(pipe + 1) : tail;
    const parts = String(titlesPart || '')
        .split('；')
        .map((x) => cleanOneLine(x))
        .filter(Boolean);
    const uniq = Array.from(new Set(parts));
    uniq.sort();
    return `n:${uniq.length}|${uniq.join('；')}`;
}

function titleKeyToList(s) {
    const norm = normalizeTitleKey(s || '');
    if (!norm) return [];
    const i = norm.indexOf('|');
    if (i < 0) return [];
    return String(norm.slice(i + 1) || '')
        .split('；')
        .map((x) => cleanOneLine(x))
        .filter(Boolean);
}

function titlesFromAnns(anns) {
    const arr = Array.isArray(anns) ? anns : [];
    const uniq = new Set();
    for (const a of arr) {
        const t = cleanOneLine(a && a.title ? a.title : '');
        if (t) uniq.add(t);
    }
    return Array.from(uniq);
}

function cacheRecTitles(rec) {
    if (!rec || typeof rec !== 'object') return [];
    const arr = Array.isArray(rec.titles) ? rec.titles : null;
    if (arr) return arr.map((x) => cleanOneLine(x)).filter(Boolean);
    if (rec.t) return titleKeyToList(rec.t);
    return [];
}

function ensureStockNameInLine(line, stockName) {
    const name = cleanOneLine(stockName || '');
    if (!name) return String(line || '');
    const rawLine = String(line || '');
    const parts = String(line || '').split('|');
    if (!parts || parts.length < 5) return String(line || '');
    const msgOrig = cleanOneLine(parts[3] || '');
    let msg0 = msgOrig;
    if (!msg0) return String(line || '');
    msg0 = msg0.replace(/^(\d{4}-\d{2}-\d{2})\s+24:/, '$1 00:');
    const mFix = /^(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(\d{2}:\d{2}:\d{2})\s+(.*)$/.exec(msg0);
    if (mFix && cleanOneLine(mFix[2]) === name) {
        const t = String(mFix[3] || '').replace(/^24:/, '00:');
        parts[3] = `${mFix[1]} ${t} ${name} ${mFix[4]}`;
        return parts.join('|');
    }
    let timePart = '';
    let rest = '';
    const mDateTime = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.*)$/.exec(msg0);
    if (mDateTime) {
        timePart = String(mDateTime[1] || '').replace(/^(\d{4}-\d{2}-\d{2})\s+24:/, '$1 00:');
        rest = mDateTime[2];
    } else {
        const m = /^(\S+)\s+(.*)$/.exec(msg0);
        if (!m) return String(line || '');
        timePart = String(m[1] || '').replace(/^(\d{4}-\d{2}-\d{2})\s+24:/, '$1 00:');
        rest = m[2];
    }
    if (rest === name || rest.startsWith(`${name} `)) {
        if (msg0 !== msgOrig) {
            parts[3] = msg0;
            return parts.join('|');
        }
        return rawLine;
    }
    parts[3] = `${timePart} ${name} ${rest}`;
    return parts.join('|');
}

function keysFromAnns(anns) {
    const arr = Array.isArray(anns) ? anns : [];
    const uniq = new Set();
    for (const a of arr) {
        const k = annStableKey(a);
        if (k) uniq.add(k);
    }
    return Array.from(uniq);
}

function pickLatestDayAnns(anns) {
    const arr = Array.isArray(anns) ? anns : [];
    if (!arr.length) return arr;
    const topTime = String(arr[0] && arr[0].time ? arr[0].time : '').trim();
    const day = topTime.length >= 10 ? topTime.slice(0, 10) : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return arr;
    return arr.filter((a) => String(a && a.time ? a.time : '').slice(0, 10) === day);
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

function formatAnnTime(timeStr) {
    const s = String(timeStr || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) return s;
    const mm = m[2];
    const dd = m[3];
    const hh = m[4];
    const mi = m[5];
    const ss = m[6] || '00';
    const mode = ANN_TIME_FORMAT === 'mmdd' || ANN_TIME_FORMAT === 'mm-dd' || ANN_TIME_FORMAT === 'date' || ANN_TIME_FORMAT === 'mmdd2'
        ? 'mmdd'
        : (ANN_TIME_FORMAT === 'hhmm' || ANN_TIME_FORMAT === 'hh:ss' || ANN_TIME_FORMAT === 'hhss' || ANN_TIME_FORMAT === 'time'
            ? 'hhmm'
            : (ANN_TIME_FORMAT === 'hhmmss' ? 'hhmmss' : 'full'));
    if (mode === 'mmdd') return `${mm}${dd}`;
    if (mode === 'hhmm') return `${hh}${mi}`;
    if (mode === 'hhmmss') return `${hh}${mi}${ss}`;
    return s;
}

function formatDecimalsInText(text) {
    const digits = Number.isFinite(ANN_DECIMAL_DIGITS) && ANN_DECIMAL_DIGITS >= 0 ? Math.floor(ANN_DECIMAL_DIGITS) : 2;
    const t = String(text || '');
    const reComma = /(?<![\d,])(\d{1,3}(?:,\d{3})+\.\d+)(?![\d,])/g;
    const rePlain = /(?<!\d)(\d+\.\d+)(?!\d)/g;
    const fmtComma = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const fmtPlain = (n) => Number(n).toFixed(digits);
    const step1 = t.replace(reComma, (m0) => {
        const n = Number(String(m0).replace(/,/g, ''));
        if (!Number.isFinite(n)) return m0;
        return fmtComma.format(n);
    });
    return step1.replace(rePlain, (m0) => {
        const n = Number(m0);
        if (!Number.isFinite(n)) return m0;
        return fmtPlain(n);
    });
}

function addLlmErrorLine(msg) {
    const one = cleanOneLine(msg || '');
    if (!one) return;
    if (llmErrorLines.includes(one)) return;
    llmErrorLines.push(one);
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
    const hh = m.hour === '24' ? '00' : m.hour;
    return `${m.year}-${m.month}-${m.day} ${hh}:${m.minute}:${m.second}`;
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

async function cninfoQuery({ seDate, pageNum, pageSize, column, plate, category }) {
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
        column: String(column || ''),
        tabName: 'fulltext',
        plate: String(plate || ''),
        stock: '',
        searchkey: '',
        secid: '',
        category: String(category || ''),
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
    const queries = Array.isArray(CNINFO_QUERIES) && CNINFO_QUERIES.length ? CNINFO_QUERIES : [{ plate: 'sz', column: 'szse' }];

    for (const q of queries) {
        const plate = q && q.plate !== undefined ? String(q.plate) : '';
        const column = q && q.column !== undefined ? String(q.column) : 'szse';
        const category = q && q.category !== undefined ? String(q.category) : '';
        let stallCount = 0;
        let lastPageSig = '';
        for (let page = 1; page <= maxPages; page += 1) {
            let j;
            try {
                const logEvery = Number.isFinite(CNINFO_LOG_EVERY_PAGES) && CNINFO_LOG_EVERY_PAGES > 0 ? Math.floor(CNINFO_LOG_EVERY_PAGES) : 0;
                const shouldLog = page === 1 || (logEvery && page % logEvery === 0) || page === maxPages;
                if (shouldLog) {
                    console.log(`ANN CNINFO query: plate=${plate || 'na'} col=${column} cat=${category || 'na'} date=${dateStr} page=${page}/${maxPages} pageSize=${pageSize}`);
                }
                j = await cninfoQuery({ seDate, pageNum: page, pageSize, column, plate, category });
            } catch (e) {
                cninfoFailCnt++;
                console.warn(`CNINFO daily query failed: plate=${plate || 'na'} col=${column} cat=${category || 'na'} date=${dateStr} page=${page} err=${e && e.message ? e.message : e}`);
                break;
            }
            const items = j && Array.isArray(j.announcements) ? j.announcements : null;
            if (!items || items.length === 0) {
                console.log(`ANN CNINFO empty: plate=${plate || 'na'} col=${column} date=${dateStr} page=${page}`);
                break;
            }
            const totalPages = j && Number.isFinite(Number(j.totalpages)) ? Number(j.totalpages) : 0;
            const pageSig = items
                .map((it) => {
                    const secCode = String((it && (it.secCode || it.sec_code)) || '').trim();
                    const announcementId = String((it && (it.announcementId || it.announcement_id)) || '').trim();
                    const epochMs = cninfoEpochMs((it && (it.announcementTime || it.announcement_time)) || '') || 0;
                    const title = String((it && (it.announcementTitle || it.announcement_title)) || '')
                        .replace(/[\r\n]+/g, ' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    const adjunctUrl = String((it && (it.adjunctUrl || it.adjunct_url)) || '').trim();
                    if (announcementId) return `id:${announcementId}`;
                    return `k:${secCode}|${epochMs}|${adjunctUrl}|${title}`;
                })
                .join(',');
            {
                const logEvery = Number.isFinite(CNINFO_LOG_EVERY_PAGES) && CNINFO_LOG_EVERY_PAGES > 0 ? Math.floor(CNINFO_LOG_EVERY_PAGES) : 0;
                const shouldLog = page === 1 || (logEvery && page % logEvery === 0) || page === maxPages;
                if (shouldLog) {
                    console.log(`ANN CNINFO items: plate=${plate || 'na'} col=${column} date=${dateStr} page=${page} items=${items.length}`);
                }
            }
            let addedNewStock = 0;
            let addedNewAnn = 0;
            for (const item of items) {
                const secCode = String(item.secCode || item.sec_code || '').trim();
                if (!secCode) continue;
                const announcementId = String(item.announcementId || item.announcement_id || '').trim();
                const epochMs = cninfoEpochMs(item.announcementTime || item.announcement_time || '') || 0;
                const title = String(item.announcementTitle || item.announcement_title || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
                const adjunctUrl = String(item.adjunctUrl || item.adjunct_url || '').trim();
                const timeStr = formatCninfoTime(item.announcementTime || item.announcement_time || '');
                const seenKey = announcementId ? `id:${announcementId}` : `k:${secCode}|${epochMs}|${adjunctUrl}|${title}`;
                if (seenAnn.has(seenKey)) continue;
                seenAnn.add(seenKey);
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
                entry.announcements.push({
                    announcementId,
                    title,
                    time: timeStr,
                    epochMs,
                    adjunctUrl
                });
                addedNewAnn++;
                if (epochMs > (entry.latestEpochMs || 0)) {
                    entry.latestEpochMs = epochMs;
                    entry.latestTime = timeStr;
                }
            }
            {
                const logEvery = Number.isFinite(CNINFO_LOG_EVERY_PAGES) && CNINFO_LOG_EVERY_PAGES > 0 ? Math.floor(CNINFO_LOG_EVERY_PAGES) : 0;
                const shouldLog = page === 1 || (logEvery && page % logEvery === 0) || page === maxPages;
                if (shouldLog) {
                    console.log(`ANN CNINFO unique: plate=${plate || 'na'} col=${column} date=${dateStr} uniqueStocks=${out.size}`);
                }
            }
            if (totalPages <= 0) {
                const sigSame = pageSig && lastPageSig && pageSig === lastPageSig;
                const noNew = addedNewAnn === 0;
                if (sigSame || noNew) stallCount += 1;
                else stallCount = 0;
            } else {
                stallCount = 0;
            }
            lastPageSig = pageSig;
            if (totalPages <= 0 && stallLimit && stallCount >= stallLimit) {
                console.log(`ANN CNINFO stop on stall: plate=${plate || 'na'} col=${column} date=${dateStr} stallPages=${stallCount}`);
                break;
            }
            if (totalPages > 0 && page >= totalPages) {
                console.log(
                    `ANN CNINFO stop on tail: plate=${plate || 'na'} col=${column} date=${dateStr} page=${page} items=${items.length} pageSize=${pageSize} totalPages=${totalPages || 'na'}`
                );
                break;
            }
        }
    }
    for (const v of out.values()) {
        const anns = Array.isArray(v.announcements) ? v.announcements : [];
        anns.sort((a, b) => {
            const ea = Number(a && a.epochMs ? a.epochMs : 0) || 0;
            const eb = Number(b && b.epochMs ? b.epochMs : 0) || 0;
            if (eb !== ea) return eb - ea;
            const ia = a && a.announcementId ? String(a.announcementId) : '';
            const ib = b && b.announcementId ? String(b.announcementId) : '';
            if (ib !== ia) return ib > ia ? 1 : -1;
            const ta = cleanOneLine(a && a.title ? a.title : '');
            const tb = cleanOneLine(b && b.title ? b.title : '');
            if (tb !== ta) return tb > ta ? 1 : -1;
            const ua = a && a.adjunctUrl ? String(a.adjunctUrl) : '';
            const ub = b && b.adjunctUrl ? String(b.adjunctUrl) : '';
            if (ub !== ua) return ub > ua ? 1 : -1;
            return 0;
        });
        v.announcements = anns;
        if (anns.length) {
            const top = anns[0];
            const topEpoch = Number(top && top.epochMs ? top.epochMs : 0) || 0;
            const topTime = String(top && top.time ? top.time : '');
            if (topEpoch > (v.latestEpochMs || 0)) v.latestEpochMs = topEpoch;
            if (topTime && !v.latestTime) v.latestTime = topTime;
        }
    }
    return out;
}

function cninfoMergeStockEntry(cur, next) {
    if (!cur) return next;
    if (!next) return cur;
    const combined = []
        .concat(Array.isArray(cur.announcements) ? cur.announcements : [])
        .concat(Array.isArray(next.announcements) ? next.announcements : []);
    const uniq = [];
    const seen = new Set();
    for (const a of combined) {
        const id = a && a.announcementId ? String(a.announcementId) : '';
        const key = id
            ? `id:${id}`
            : `t:${String(a && a.time ? a.time : '')}|${String(a && a.title ? a.title : '')}|${String(a && a.adjunctUrl ? a.adjunctUrl : '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        uniq.push(a);
    }
    uniq.sort((a, b) => {
        const ea = Number(a && a.epochMs ? a.epochMs : 0) || 0;
        const eb = Number(b && b.epochMs ? b.epochMs : 0) || 0;
        if (eb !== ea) return eb - ea;
        const ia = a && a.announcementId ? String(a.announcementId) : '';
        const ib = b && b.announcementId ? String(b.announcementId) : '';
        if (ib !== ia) return ib > ia ? 1 : -1;
        const ta = cleanOneLine(a && a.title ? a.title : '');
        const tb = cleanOneLine(b && b.title ? b.title : '');
        if (tb !== ta) return tb > ta ? 1 : -1;
        const ua = a && a.adjunctUrl ? String(a.adjunctUrl) : '';
        const ub = b && b.adjunctUrl ? String(b.adjunctUrl) : '';
        if (ub !== ua) return ub > ua ? 1 : -1;
        return 0;
    });
    cur.announcements = uniq;
    if ((next.latestEpochMs || 0) > (cur.latestEpochMs || 0)) {
        cur.latestEpochMs = next.latestEpochMs || 0;
        cur.latestTime = next.latestTime || '';
    }
    if (!cur.secName && next.secName) cur.secName = next.secName;
    return cur;
}

async function cninfoPickDays(lookbackDays) {
    const d = Number.isFinite(lookbackDays) && lookbackDays > 0 ? Math.floor(lookbackDays) : 1;
    const days = Math.min(Math.max(d, 1), 14);
    const merged = new Map();
    for (let off = 0; off >= -(days - 1); off -= 1) {
        const day = cninfoDateString(off);
        const dayMap = await cninfoDailyByStock(day);
        for (const [k, v] of dayMap.entries()) {
            const cur = merged.get(k);
            if (!cur) merged.set(k, v);
            else merged.set(k, cninfoMergeStockEntry(cur, v));
        }
    }
    return merged;
}

async function llmSummarizeAnnouncement({ secCode, secName, announcementTime, announcementTitle }, maxChars, rawText = '') {
    const fallback = cutByChars(announcementTitle || '', maxChars);
    if (!LLM_API_KEY) {
        if (!llmMissingApiKeyNoted) {
            llmMissingApiKeyNoted = true;
            addLlmErrorLine('LLM_API_KEY 缺失，公告摘要已回退为标题/标题拼接。');
        }
        llmDebugLog(`ANN LLM off: missing apiKey sec=${secCode || ''}`);
        llmFallbackCnt++;
        return fallback;
    }
    const titleOneLine = cleanOneLine(announcementTitle || '');
    const payload = cleanOneLine(rawText || '') || titleOneLine;
    const basePrompt = [
        `你是财经快讯编辑。请将下列公告通读后，产出一条用于短信/邮件的“公告要点”。`,
        '要求：',
        `- 不超过${maxChars}个汉字`,
        '- 要点要像财经网站标题一样精炼（尽量<=40个汉字），信息密度高，只写事实不推测/不编造，数字和单位尽量原样保留',
        '- 不要出现公司名称/简称/股票名称（可用“公司”代替或省略主语）',
        '- 不要输出标题字样，不要换行',
        '- 若包含多份公告正文（例如多段以【标题】开头），优先提炼业绩/财报/分红/业绩预告等；若无业绩信息，再提炼最重要的一条事项',
        '',
        `输入：股票:${secCode} 时间:${announcementTime} 标题:${titleOneLine} 正文:${payload}`
    ].join('\n');
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
            addLlmErrorLine(`sec=${secCode || ''} LLM 返回空内容，回退标题。`);
            llmDebugLog(`ANN LLM empty: sec=${secCode || ''} fallback=title`);
            llmFallbackCnt++;
            return fallback;
        }
        const firstNorm = cleanOneLine(first);
        const titleNorm = titleOneLine;
        if (titleNorm && firstNorm && (firstNorm === titleNorm || firstNorm.replace(/[。.!！?？]/g, '') === titleNorm.replace(/[。.!！?？]/g, ''))) {
            llmSameAsTitleCnt++;
            llmDebugLog(`ANN LLM retry: sec=${secCode || ''} reason=sameAsTitle titleChars=${titleNorm.length} outChars=${firstNorm.length}`);
            const retryPrompt = [
                '不要照抄标题。请从正文改写出一条更简洁的公告要点。',
                '要求：',
                `- 不超过${maxChars}个汉字`,
                '- 只写事实不推测/不编造，数字和单位尽量原样保留',
                '- 不要出现公司名称/简称/股票名称（可用“公司”代替或省略主语）',
                '- 不要换行',
                '若正文不足以提取，请输出“正文不足，建议查看公告全文”。',
                '',
                `输入：股票:${secCode} 时间:${announcementTime} 标题:${titleNorm} 正文:${payload}`
            ].join('\n');
            const second = await callOnce(retryPrompt);
            if (second) return cleanOneLine(second);
            addLlmErrorLine(`sec=${secCode || ''} LLM 二次重试后仍为空，回退标题。`);
        }
        return firstNorm;
    } catch (e) {
        llmFailCnt++;
        const sc = e && e.statusCode ? String(e.statusCode) : '';
        console.warn(`LLM summarize failed: ${secCode} status=${sc || 'na'} err=${e && e.message ? e.message : e}`);
        addLlmErrorLine(`sec=${secCode || ''} status=${sc || 'na'} err=${e && e.message ? e.message : e}`);
        if (e && e.body) {
            addLlmErrorLine(`sec=${secCode || ''} body=${cutByChars(e.body, 260)}`);
        }
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

function loadStockMetaMaps() {
    try {
        const raw = fs.readFileSync(STOCK_LIST_PATH, 'utf8');
        const j = JSON.parse(raw);
        const stocks = j && Array.isArray(j.stocks) ? j.stocks : [];
        const exchangeMap = new Map();
        const nameMap = new Map();
        for (const s of stocks) {
            const id = s && s.f12 ? String(s.f12) : '';
            if (!id) continue;
            let ex = s && (s.f13 === 0 || s.f13 === 1 || s.f13 === 2 || s.f13 === 9 || s.f13 === 4 || s.f13 === 8)
                ? String(s.f13)
                : (s && s.f13 !== undefined ? String(s.f13) : '');
            if (id.startsWith('8') || id.startsWith('4') || id.startsWith('9')) ex = '2';
            if (!ex) continue;
            exchangeMap.set(id, ex);
            const name = s && s.f14 ? cleanOneLine(String(s.f14)) : '';
            if (name) nameMap.set(id, name);
        }
        return { exchangeMap, nameMap };
    } catch {
        return { exchangeMap: new Map(), nameMap: new Map() };
    }
}

function loadStockCodesSet(exchangeMap) {
    try {
        if (fs.existsSync(STOCK_CODES_PATH)) {
            const raw = fs.readFileSync(STOCK_CODES_PATH, 'utf8');
            const codes = String(raw || '')
                .split(/\r?\n/g)
                .map((s) => String(s || '').trim())
                .filter(Boolean);
            if (codes.length) return new Set(codes);
        }
    } catch {}
    try {
        const keys = exchangeMap && typeof exchangeMap.keys === 'function' ? Array.from(exchangeMap.keys()) : [];
        return new Set(keys);
    } catch {
        return new Set();
    }
}

function fallbackExchangeId(stockId) {
    const id = String(stockId || '');
    if (id.startsWith('8') || id.startsWith('4') || id.startsWith('9')) return '2';
    if (id.startsWith('6')) return '1';
    return '0';
}

function loadExistingOutputLines(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const lines = String(raw || '')
            .split(/\r?\n/g)
            .map((s) => String(s || '').trim())
            .filter(Boolean);
        const order = [];
        const map = new Map();
        const extra = [];
        for (const line of lines) {
            const parts = String(line || '').split('|');
            const stockId = parts && parts.length >= 2 ? String(parts[1] || '').trim() : '';
            if (!stockId) {
                extra.push(line);
                continue;
            }
            if (!map.has(stockId)) order.push(stockId);
            map.set(stockId, line);
        }
        return { order, map, extra };
    } catch {
        return { order: [], map: new Map(), extra: [] };
    }
}

function loadSummaryCache(filePath) {
    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        const j = JSON.parse(String(raw || ''));
        if (!j || typeof j !== 'object') return {};
        return j;
    } catch {
        return {};
    }
}

function saveSummaryCache(filePath, cacheObj) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(cacheObj || {}, null, 2) + '\n', 'utf8');
    } catch {}
}

async function main() {
    console.log(`ANN Start: out=${ANN_OUTPUT_PATH}`);
    console.log(`ANN Config: tz=${CNINFO_TZ} pageSize=${CNINFO_PAGE_SIZE} maxPages=${CNINFO_MAX_PAGES} stallPages=${CNINFO_STALL_PAGES} timeoutMs=${CNINFO_TIMEOUT_MS}`);
    console.log(`ANN CNINFO plates: ${CNINFO_PLATES && CNINFO_PLATES.length ? CNINFO_PLATES.join(',') : 'sz'}`);
    console.log(`ANN Output: timeFormat=${ANN_TIME_FORMAT || 'full'} decimals=${Number.isFinite(ANN_DECIMAL_DIGITS) ? Math.floor(ANN_DECIMAL_DIGITS) : 2}`);
    console.log(`ANN Summary: chars=${ANNOUNCEMENT_SUMMARY_CHARS} conc=${ANNOUNCEMENT_SUMMARY_CONCURRENCY} llm=${LLM_API_KEY ? 'on' : 'off'} model=${LLM_MODEL} base=${LLM_BASE_URL}`);
    console.log(`ANN PDF: parser=${pdfParse ? 'on' : 'off'} maxPerStockDay=${ANNOUNCEMENT_MAX_PER_STOCK_DAY} maxPerStockRange=${ANNOUNCEMENT_MAX_PER_STOCK_RANGE} pdfConc=${ANNOUNCEMENT_PDF_CONCURRENCY} pdfMaxChars=${ANNOUNCEMENT_PDF_MAX_CHARS}`);
    const proxy = getTunnelProxyConfig();
    console.log(`ANN Proxy: ${proxy ? `${proxy.host}:${proxy.port}` : 'off'}`);
    const { exchangeMap, nameMap } = loadStockMetaMaps();
    const stockCodes = loadStockCodesSet(exchangeMap);
    console.log(`ANN Stock list: path=${STOCK_LIST_PATH} size=${exchangeMap.size} codes=${stockCodes.size} codesPath=${STOCK_CODES_PATH}`);
    const d = Number.isFinite(ANN_LOOKBACK_DAYS) && ANN_LOOKBACK_DAYS > 0 ? Math.floor(ANN_LOOKBACK_DAYS) : 1;
    const lookbackDays = Math.min(Math.max(d, 1), 14);
    const today = cninfoDateString(0);
    const fromDay = cninfoDateString(-(lookbackDays - 1));
    console.log(`ANN Dates: from=${fromDay} to=${today} lookbackDays=${lookbackDays}`);
    const summaryCache = loadSummaryCache(ANN_SUMMARY_CACHE_PATH);
    const runTimes = Number.isFinite(ANN_RUN_TIMES) && ANN_RUN_TIMES > 0 ? Math.floor(ANN_RUN_TIMES) : 1;
    const runs = Math.min(Math.max(runTimes, 1), 10);
    console.log(`ANN Runs: ${runs}`);
    const oldOut = loadExistingOutputLines(ANN_OUTPUT_PATH);
    const mergedOrder = oldOut.order.slice();
    const mergedMap = new Map(oldOut.map);
    for (const stockId of mergedOrder) {
        const oldLine = mergedMap.get(stockId);
        if (!oldLine) continue;
        const patched = ensureStockNameInLine(oldLine, nameMap.get(stockId) || '');
        if (patched && patched !== oldLine) mergedMap.set(stockId, patched);
    }
    if (mergedOrder.length === 0 && mergedMap.size === 0 && summaryCache && typeof summaryCache === 'object') {
        const arr = [];
        for (const k of Object.keys(summaryCache)) {
            const stockId = String(k || '').trim();
            if (!stockId) continue;
            const rec = summaryCache && summaryCache[stockId] ? summaryCache[stockId] : null;
            const line = rec && rec.line ? String(rec.line).trim() : '';
            if (!line) continue;
            const parts = line.split('|');
            if (!parts || parts.length < 5) continue;
            if (String(parts[1] || '').trim() !== stockId) continue;
            if (String(parts[2] || '').trim() !== '22') continue;
            const patched = ensureStockNameInLine(line, nameMap.get(stockId) || '');
            arr.push({ stockId, line: patched || line, ts: Number(rec && rec.ts ? rec.ts : 0) || 0 });
        }
        arr.sort((a, b) => (b.ts || 0) - (a.ts || 0) || String(a.stockId).localeCompare(String(b.stockId)));
        for (const it of arr) {
            mergedOrder.push(it.stockId);
            mergedMap.set(it.stockId, it.line);
        }
        if (arr.length) console.log(`ANN Prefill from cache: ${arr.length}`);
    }
    let totalAdded = 0;
    let totalUpdated = 0;
    let totalUnchanged = 0;
    let totalCacheHit = 0;
    let lastFetchedCnt = 0;
    let lastAnnListLen = 0;
    if (LLM_API_KEY && !pdfParse && !llmPdfParserMissingNoted) {
        llmPdfParserMissingNoted = true;
        addLlmErrorLine('pdf-parse 不可用，LLM 输入将退化为标题文本，无法通读公告正文。');
    }

    for (let run = 1; run <= runs; run += 1) {
        console.log(`ANN Run: ${run}/${runs}`);
        const merged = await cninfoPickDays(lookbackDays);
        const all = Array.from(merged.values()).filter((x) => x && x.secCode && stockCodes.has(String(x.secCode)));
        const windowHours = Number.isFinite(ANN_UPDATE_WINDOW_HOURS) && ANN_UPDATE_WINDOW_HOURS > 0 ? ANN_UPDATE_WINDOW_HOURS : 0;
        const nowMs = Date.now();
        const windowStartMs = windowHours ? nowMs - Math.floor(windowHours * 3600 * 1000) : 0;
        const annList = windowHours
            ? all.filter((x) => (Number(x && x.latestEpochMs ? x.latestEpochMs : 0) || 0) >= windowStartMs)
            : all;
        console.log(
            `ANN Latest unique stocks: total=${all.length} selected=${annList.length} windowHours=${windowHours || 'off'}`
        );
        lastAnnListLen = all.length;
        let cacheHitCnt = 0;
        const titleHitStocks = new Set();

        const summaries = await summarizeWithConcurrency(
            annList,
            ANNOUNCEMENT_SUMMARY_CONCURRENCY,
            async (entry) => {
                const secCode = entry && entry.secCode ? String(entry.secCode) : '';
                const secName = entry && entry.secName ? String(entry.secName) : '';
                const announcementTime = entry && entry.latestTime ? String(entry.latestTime) : '';
                const annsAllRaw = entry && Array.isArray(entry.announcements) ? entry.announcements : [];
                const annsAll = pickLatestDayAnns(annsAllRaw);
                const cap = Number.isFinite(ANNOUNCEMENT_MAX_PER_STOCK_RANGE) && ANNOUNCEMENT_MAX_PER_STOCK_RANGE > 0
                    ? Math.floor(ANNOUNCEMENT_MAX_PER_STOCK_RANGE)
                    : 0;
                const anns = cap ? annsAll.slice(0, cap) : annsAll;
                llmDebugLog(`ANN Summarize: sec=${secCode || ''} anns=${anns.length} pdf=${LLM_API_KEY && pdfParse ? 'on' : 'off'}`);
                const titles = anns.map((a) => cleanOneLine(a.title || '')).filter(Boolean);
                const titleJoined = titles.join('；');

                const payloadTitle = titleJoined || (titles[0] || '');
                const cacheRec = secCode && summaryCache && summaryCache[secCode] ? summaryCache[secCode] : null;
                const cachedTitles = cacheRecTitles(cacheRec);
                const cachedSet = new Set(cachedTitles);
                const currentAllTitles = titlesFromAnns(annsAll);
                const currentAllKeys = keysFromAnns(annsAll);
                const cachedKeys = cacheRec && Array.isArray(cacheRec.keys) ? cacheRec.keys.map((x) => String(x || '')) : [];
                const cachedKeySet = new Set(cachedKeys);
                const missingKeys = currentAllKeys.filter((k) => !cachedKeySet.has(k));
                const missingTitles = currentAllTitles.filter((t) => !cachedSet.has(t));
                const isOld = currentAllKeys.length ? missingKeys.length === 0 : missingTitles.length === 0;
                if (cacheRec && cacheRec.s && isOld) {
                    cacheHitCnt += 1;
                    if (secCode) titleHitStocks.add(secCode);
                    summaryCache[secCode] = {
                        ...cacheRec,
                        keys: Array.from(new Set(cachedKeys.concat(currentAllKeys))).sort(),
                        titles: Array.from(new Set(cachedTitles.concat(currentAllTitles))).sort(),
                        ts: Date.now()
                    };
                    return String(cacheRec.s);
                }
                if (!LLM_API_KEY || !pdfParse) {
                    const out = await llmSummarizeAnnouncement(
                        { secCode, secName, announcementTime, announcementTitle: payloadTitle },
                        ANNOUNCEMENT_SUMMARY_CHARS,
                        payloadTitle
                    );
                    if (secCode && out) {
                        summaryCache[secCode] = {
                            ...cacheRec,
                            keys: Array.from(new Set(cachedKeys.concat(currentAllKeys))).sort(),
                            titles: Array.from(new Set(cachedTitles.concat(currentAllTitles))).sort(),
                            s: out,
                            ts: Date.now()
                        };
                    }
                    return out;
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
                const out = await llmSummarizeAnnouncement(
                    { secCode, secName, announcementTime, announcementTitle: payloadTitle },
                    ANNOUNCEMENT_SUMMARY_CHARS,
                    payloadText
                );
                if (secCode && out) {
                    summaryCache[secCode] = {
                        ...cacheRec,
                        keys: Array.from(new Set(cachedKeys.concat(currentAllKeys))).sort(),
                        titles: Array.from(new Set(cachedTitles.concat(currentAllTitles))).sort(),
                        s: out,
                        ts: Date.now()
                    };
                }
                return out;
            }
        );

        const newMap = new Map();
        const newOrder = [];
        const newStockNameMap = new Map();
        let cnt = 0;
        for (let i = 0; i < annList.length; i += 1) {
            const ann = annList[i];
            const stockId = ann && ann.secCode ? String(ann.secCode) : '';
            if (!stockId) continue;
            const exchangeId = exchangeMap.get(stockId) || fallbackExchangeId(stockId);
            const stockName = nameMap.get(stockId) || cleanOneLine(ann && ann.secName ? ann.secName : '');
            const t = formatAnnTime(cleanOneLine(ann.latestTime || ''));
            const s = formatDecimalsInText(cleanOneLine(summaries[i] || ''));
            if (!t || !s) continue;
            const line = `${exchangeId}|${stockId}|22|${t} ${stockName ? `${stockName} ` : ''}${s}|0.000`;
            if (!newMap.has(stockId)) newOrder.push(stockId);
            newMap.set(stockId, line);
            if (stockName) newStockNameMap.set(stockId, stockName);
            {
                const prev = summaryCache && summaryCache[stockId] ? summaryCache[stockId] : null;
                summaryCache[stockId] = {
                    ...(prev && typeof prev === 'object' ? prev : {}),
                    t,
                    n: stockName || (prev && prev.n ? prev.n : ''),
                    line,
                    ts: Date.now()
                };
            }
            cnt++;
        }

        let updated = 0;
        let added = 0;
        let unchanged = 0;
        let updatedPrinted = 0;
        for (const stockId of newOrder) {
            const line = newMap.get(stockId);
            if (!line) continue;
            const oldLine = mergedMap.get(stockId);
            if (oldLine) {
                if (titleHitStocks.has(stockId)) {
                    unchanged += 1;
                    const patched = ensureStockNameInLine(oldLine, newStockNameMap.get(stockId) || '');
                    if (patched && patched !== oldLine) mergedMap.set(stockId, patched);
                    continue;
                }
                if (oldLine === line) {
                    unchanged += 1;
                    continue;
                }
                updated += 1;
                if (
                    ANN_PRINT_UPDATED &&
                    updatedPrinted <
                        (Number.isFinite(ANN_PRINT_UPDATED_LIMIT) && ANN_PRINT_UPDATED_LIMIT > 0 ? Math.floor(ANN_PRINT_UPDATED_LIMIT) : 0)
                ) {
                    updatedPrinted += 1;
                    console.log(`ANN Updated: ${stockId} old="${oldLine}" new="${line}"`);
                }
            } else {
                mergedOrder.push(stockId);
                added += 1;
            }
            mergedMap.set(stockId, line);
        }

        lastFetchedCnt = cnt;
        totalAdded += added;
        totalUpdated += updated;
        totalUnchanged += unchanged;
        totalCacheHit += cacheHitCnt;
        console.log(`ANN Run merged: cnt=${cnt} new=${added} updated=${updated} unchanged=${unchanged} cacheHit=${cacheHitCnt}`);
    }
    const lines = mergedOrder.map((k) => mergedMap.get(k)).filter(Boolean).concat(oldOut.extra);
    fs.writeFileSync(ANN_OUTPUT_PATH, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    console.log(`公告家数: ${mergedMap.size} 合并: total=${lines.length} new=${totalAdded} updated=${totalUpdated} unchanged=${totalUnchanged}`);
    saveSummaryCache(ANN_SUMMARY_CACHE_PATH, summaryCache);
    if (totalCacheHit > 0) console.log(`ANN Cache hit: ${totalCacheHit}`);
    const llmAbnormal = !LLM_API_KEY || llmFailCnt > 0 || llmErrorLines.length > 0 || (lastAnnListLen > 0 && llmUsedCnt === 0);
    if (llmAbnormal) {
        console.warn(`ANN LLM ALERT: used=${llmUsedCnt} fail=${llmFailCnt} fallback=${llmFallbackCnt} sameAsTitle=${llmSameAsTitleCnt}`);
        for (const one of llmErrorLines.slice(0, 12)) {
            console.warn(`ANN LLM ERROR: ${one}`);
        }
        if (llmErrorLines.length > 12) {
            console.warn(`ANN LLM ERROR: 其余 ${llmErrorLines.length - 12} 条已省略`);
        }
    }
    console.log(
        `ANN Done: written=${mergedMap.size} lastRunWritten=${lastFetchedCnt} runs=${runs} cninfoFail=${cninfoFailCnt} llmUsed=${llmUsedCnt} llmSameAsTitle=${llmSameAsTitleCnt} llmFallback=${llmFallbackCnt} llmFail=${llmFailCnt}`
    );
}

main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
});
