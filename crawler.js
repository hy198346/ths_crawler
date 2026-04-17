const http = require("http");
const https = require('https');
const tunnel = require('tunnel');
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require('child_process');
const { Buffer } = require('buffer');
const { URL } = require('url');

const crawler_config = require('./crawler-config');
const crawler_tools = require('./crawler-tools');

const MAX_TUNNEL_PROXY_FAILURES = 200;

let tunnelProxyFailureCount = 0;
let tunnelProxyDisabled = false;
let tunnelProxyDisabledUntil = 0;
let tunnelProxyPreferredUntil = 0;

const tunnelSecretPath = path.join(__dirname, 'crawler-secret.json');
let tunnelSecretCache;

function loadTunnelSecret() {
    if (tunnelSecretCache !== undefined) return tunnelSecretCache;

    const tunnelStr = process.env.TUNNEL_PROXY ? String(process.env.TUNNEL_PROXY) : '';
    const username = process.env.TUNNEL_USERNAME ? String(process.env.TUNNEL_USERNAME) : '';
    const password = process.env.TUNNEL_PASSWORD ? String(process.env.TUNNEL_PASSWORD) : '';
    if (tunnelStr && username && password) {
        tunnelSecretCache = { tunnel: tunnelStr, username, password };
        return tunnelSecretCache;
    }

    if (fs.existsSync(tunnelSecretPath)) {
        try {
            const raw = fs.readFileSync(tunnelSecretPath, 'utf8');
            const parsed = JSON.parse(raw);
            const fileTunnel = parsed && parsed.tunnel ? String(parsed.tunnel) : '';
            const fileUser = parsed && parsed.username ? String(parsed.username) : '';
            const filePass = parsed && parsed.password ? String(parsed.password) : '';
            if (fileTunnel && fileUser && filePass) {
                tunnelSecretCache = { tunnel: fileTunnel, username: fileUser, password: filePass };
                return tunnelSecretCache;
            }
            console.warn('crawler-secret.json 字段不完整，将使用直连模式');
        } catch (e) {
            console.warn('crawler-secret.json 读取失败，将使用直连模式');
        }
    }

    tunnelSecretCache = null;
    if (process.env.GITHUB_ACTIONS === 'true') {
        console.warn('未配置隧道代理凭据（TUNNEL_PROXY/TUNNEL_USERNAME/TUNNEL_PASSWORD），将使用直连模式');
    }
    return tunnelSecretCache;
}

function getTunnelProxy() {
    const secret = loadTunnelSecret();
    if (!secret) return null;
    const [host, portStr] = String(secret.tunnel).split(':');
    const port = Number(portStr);
    const token = Buffer.from(`${secret.username}:${secret.password}`).toString('base64');
    return {
        host,
        port,
        authHeader: `Basic ${token}`
    };
}

function onTunnelProxySuccess() {
    tunnelProxyFailureCount = 0;
}

function markTunnelProxyFailure({ resetGlobalAgents = true } = {}) {
    tunnelProxyFailureCount += 1;
    if (resetGlobalAgents) {
        resetTunnelAgents();
    }
    if (
        process.env.GITHUB_ACTIONS !== 'true' &&
        !tunnelProxyDisabled &&
        tunnelProxyFailureCount >= MAX_TUNNEL_PROXY_FAILURES
    ) {
        tunnelProxyDisabled = true;
        console.warn(`Tunnel proxy disabled after ${tunnelProxyFailureCount} failures; falling back to direct connection.`);
    }
}

function onTunnelProxyFailure() {
    markTunnelProxyFailure();
}

function isTunnelProxyEnabled() {
    if (!loadTunnelSecret()) return false;
    if (tunnelProxyDisabledUntil && Date.now() < tunnelProxyDisabledUntil) return false;
    return !tunnelProxyDisabled;
}

function temporarilyDisableTunnelProxy(ms) {
    const now = Date.now();
    tunnelProxyDisabledUntil = Math.max(tunnelProxyDisabledUntil, now + ms);
}

function preferTunnelProxyFor(ms) {
    const now = Date.now();
    tunnelProxyPreferredUntil = Math.max(tunnelProxyPreferredUntil, now + ms);
}

function shouldPreferTunnelProxy() {
    return tunnelProxyPreferredUntil && Date.now() < tunnelProxyPreferredUntil;
}

function getBufferDirect(targetUrl, headers = {}, timeoutMs) {
    return new Promise((resolve, reject) => {
        const isHttps = targetUrl.protocol === 'https:';
        const client = isHttps ? https : http;
        const agent = isHttps ? httpsAgent : httpAgent;
        const req = client.get(
            {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                path: `${targetUrl.pathname}${targetUrl.search}`,
                headers,
                agent,
                timeout: timeoutMs
            },
            (res) => {
                if (res.statusCode !== 200) {
                    const err = new Error(`Status code: ${res.statusCode}`);
                    err.statusCode = res.statusCode;
                    return reject(err);
                }

                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }
        );

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Request timeout'));
        });
    });
}

function getBufferViaTunnelProxy(targetUrl, headers = {}, timeoutMs) {
    const isHttps = targetUrl.protocol === 'https:';
    if (!isHttps) {
        const proxy = getTunnelProxy();
        initTunnelAgents();
        return new Promise((resolve, reject) => {
            const req = http.get(
                {
                    hostname: proxy.host,
                    port: proxy.port,
                    path: targetUrl.href,
                    headers: {
                        ...headers,
                        Host: targetUrl.host,
                        'Proxy-Authorization': proxy.authHeader
                    },
                    agent: proxyHttpKeepAliveAgent,
                    timeout: timeoutMs
                },
                (res) => {
                    if (res.statusCode === 407) {
                        const err = new Error(`Proxy authentication required (status code: ${res.statusCode})`);
                        err.statusCode = res.statusCode;
                        err.isTunnelProxyError = true;
                        return reject(err);
                    }
                    if (res.statusCode !== 200) {
                        const err = new Error(`Status code: ${res.statusCode}`);
                        err.statusCode = res.statusCode;
                        err.isTunnelProxyError = true;
                        return reject(err);
                    }

                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                }
            );

            req.on('error', (e) => {
                e.isTunnelProxyError = true;
                reject(e);
            });
            req.on('timeout', () => {
                const err = new Error('Request timeout');
                err.isTunnelProxyError = true;
                req.destroy();
                reject(err);
            });
        });
    }

    initTunnelAgents();
    return new Promise((resolve, reject) => {
        const req = https.get(
            {
                hostname: targetUrl.hostname,
                port: targetUrl.port || 443,
                path: `${targetUrl.pathname}${targetUrl.search}`,
                headers,
                agent: tunnelHttpsAgent,
                timeout: timeoutMs
            },
            (res) => {
                if (res.statusCode === 407) {
                    const err = new Error(`Proxy authentication required (status code: ${res.statusCode})`);
                    err.statusCode = res.statusCode;
                    err.isTunnelProxyError = true;
                    return reject(err);
                }
                if (res.statusCode !== 200) {
                    const err = new Error(`Status code: ${res.statusCode}`);
                    err.statusCode = res.statusCode;
                    err.isTunnelProxyError = true;
                    return reject(err);
                }

                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }
        );

        req.on('error', (e) => {
            e.isTunnelProxyError = true;
            reject(e);
        });
        req.on('timeout', () => {
            const err = new Error('Request timeout');
            err.isTunnelProxyError = true;
            req.destroy();
            reject(err);
        });
    });
}

async function getBufferWithTunnelPolicy(targetUrl, headers = {}, timeoutMs, session) {
    if (shouldPreferTunnelProxy() && isTunnelProxyEnabled()) {
        try {
            const data = session
                ? await getBufferViaTunnelProxySession(targetUrl, headers, timeoutMs, session)
                : await getBufferViaTunnelProxy(targetUrl, headers, timeoutMs);
            onTunnelProxySuccess();
            return data;
        } catch (e) {
            if (e && e.isTunnelProxyError) {
                onTunnelProxyFailure();
            }
        }
    }

    return getBufferDirect(targetUrl, headers, timeoutMs);
}

// 配置常量
const STOCK_INFO_FILE_PATH = process.env.STOCK_INFO_FILE_PATH || crawler_config.config.filePath;
const SLEEP_TIME = crawler_config.config.sleepTime;
const TASK_COUNT = crawler_config.config.taksCount;
const TASK_SLEEP_COUNT = crawler_config.config.taskSleepCount;
const MAX_COUNT = crawler_config.config.maxCount;
const ONLY_STOCK_LIST = !!crawler_config.config.onlyStockList;
const MAX_STOCKS = Number(process.env.MAX_STOCKS || crawler_config.config.maxStocks || 0);
const IS_CI = process.env.GITHUB_ACTIONS === 'true';
const STOCK_WORKER_CAP = Number(crawler_config.config.workerCap || 200);
const STOCK_LIST_CONCURRENCY = Number(crawler_config.config.listConcurrency || 8);
const STOCK_FETCH_TIMEOUT = Number(crawler_config.config.fetchTimeout || 12000);
const CI_MAIN_TIMEOUT = Number(crawler_config.config.ciMainTimeout || STOCK_FETCH_TIMEOUT);
const CI_RECOVERY_TIMEOUT = Number(
    crawler_config.config.ciRecoveryTimeout || crawler_config.config.ciFetchTimeout || 20000
);
const CI_DIRECT_FALLBACK = crawler_config.config.ciDirectFallback !== false;
const CI_MAIN_MAX_RETRIES = Number(crawler_config.config.ciMainMaxRetries || 2);
const CI_DIRECT_FALLBACK_MS = Number(crawler_config.config.ciDirectFallbackMs || 30000);
const TUNNEL_ON_BLOCKED_MS = Number(crawler_config.config.tunnelOnBlockedMs || 60000);
const STOCK_FETCH_TIMEOUT_EFFECTIVE = IS_CI ? CI_MAIN_TIMEOUT : STOCK_FETCH_TIMEOUT;
const STOCK_RETRY_BASE_DELAY = Number(crawler_config.config.retryBaseDelay || 200);
const STOCK_RETRY_MAX_DELAY = Number(crawler_config.config.retryMaxDelay || 2500);
const STOCK_SESSION_POOL_SIZE = Number(crawler_config.config.sessionPoolSize || 20);
const STOCK_MAX_RETRIES = Number(crawler_config.config.stockMaxRetries || 3);
const STOCK_RECOVERY_ROUNDS = Number(crawler_config.config.recoveryRounds || 1);
const STOCK_RECOVERY_WORKER_CAP = Number(crawler_config.config.recoveryWorkerCap || 60);
const STOCK_RECOVERY_MAX_RETRIES = Number(crawler_config.config.recoveryMaxRetries || 6);
const STOCK_STALL_RESET_MS = 60000;
const ADAPTIVE_CONCURRENCY_ENABLED = crawler_config.config.adaptiveConcurrency !== false;
const ADAPTIVE_MIN_WORKERS = Number(crawler_config.config.adaptiveMinWorkers || 40);
const ADAPTIVE_WINDOW_SIZE = Number(crawler_config.config.adaptiveWindowSize || 200);
const ADAPTIVE_HANGUP_HIGH = Number(crawler_config.config.adaptiveHangupHigh || 0.12);
const ADAPTIVE_HANGUP_LOW = Number(crawler_config.config.adaptiveHangupLow || 0.03);
const ADAPTIVE_ADJUST_COOLDOWN_MS = Number(crawler_config.config.adaptiveAdjustCooldownMs || 15000);
const ADAPTIVE_SEVERE_NETERR = 0.6;
const ADAPTIVE_PAUSE_MS = 5000;
const ENABLE_ANNOUNCEMENTS = process.env.ENABLE_ANNOUNCEMENTS === 'true';

// 正则表达式常�?
const STOCK_SALE_LIMIT_REGEX = /预计解除限售|限售解禁/;
const STOCK_REDUCE_REGEX = /增减持计划|增持|减持/;
const STOCK_INVESTIGATE_REGEX = /立案调查/;

const CNINFO_PAGE_SIZE = Number(process.env.CNINFO_PAGE_SIZE || 50);
const CNINFO_MAX_PAGES = Number(process.env.CNINFO_MAX_PAGES || 400);
const CNINFO_TIMEOUT_MS = Number(process.env.CNINFO_TIMEOUT_MS || 20000);
const CNINFO_PLATES = String(process.env.CNINFO_PLATES || 'sz,sh')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const CNINFO_QUERIES = (CNINFO_PLATES && CNINFO_PLATES.length ? CNINFO_PLATES : ['sz']).map((plate) => {
    const p = String(plate || '').trim();
    const column = p === 'sh' ? 'sse' : 'szse';
    return { plate: p, column };
});
const ANNOUNCEMENT_SUMMARY_CHARS = Number(process.env.ANNOUNCEMENT_SUMMARY_CHARS || 200);
const ANNOUNCEMENT_SUMMARY_CONCURRENCY = Number(process.env.ANNOUNCEMENT_SUMMARY_CONCURRENCY || 3);
const LLM_MODEL = process.env.KIMI_MODEL || process.env.LLM_MODEL || 'kimi-k2-turbo-preview';
const LLM_BASE_URL = (process.env.KIMI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || process.env.LLM_API_KEY || '';
const LLM_DEBUG = ['1', 'true', 'yes', 'on'].includes(String(process.env.KIMI_DEBUG || process.env.LLM_DEBUG || '').trim().toLowerCase());
const CNINFO_TZ = process.env.CNINFO_TZ || 'Asia/Shanghai';
const ANN_TIME_FORMAT = String(process.env.ANN_TIME_FORMAT || '').trim().toLowerCase();
const ANN_DECIMAL_DIGITS = Number(process.env.ANN_DECIMAL_DIGITS || 2);

// Agent 缓存，用于连接复用与并发优化
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 2000 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 2000 });
let tunnelHttpAgent = null;
let tunnelHttpsAgent = null;
let proxyHttpKeepAliveAgent = null;
const STOCK_LIST_CACHE_PATH = path.join(__dirname, 'stock_list_cache.json');
const STOCK_LIST_SAVED_PATH = path.join(__dirname, 'stock_list.json');
const STOCK_CODE_LIST_PATH = path.join(__dirname, 'stock_codes.txt');
const CRAWLER_PROGRESS_ONLY = !['0', 'false', 'no', 'off'].includes(
    String(process.env.CRAWLER_PROGRESS_ONLY || '1').trim().toLowerCase()
);

function logDetail(msg) {
    if (CRAWLER_PROGRESS_ONLY) return;
    console.log(String(msg || ''));
}

function logErrorDetail(msg) {
    if (CRAWLER_PROGRESS_ONLY) return;
    console.error(String(msg || ''));
}

function resetTunnelAgents() {
    try {
        if (tunnelHttpAgent && typeof tunnelHttpAgent.destroy === 'function') tunnelHttpAgent.destroy();
    } catch {}
    try {
        if (tunnelHttpsAgent && typeof tunnelHttpsAgent.destroy === 'function') tunnelHttpsAgent.destroy();
    } catch {}
    try {
        if (proxyHttpKeepAliveAgent && typeof proxyHttpKeepAliveAgent.destroy === 'function') proxyHttpKeepAliveAgent.destroy();
    } catch {}

    tunnelHttpAgent = null;
    tunnelHttpsAgent = null;
    proxyHttpKeepAliveAgent = null;
}

function initTunnelAgents() {
    if (!tunnelHttpAgent || !tunnelHttpsAgent || !proxyHttpKeepAliveAgent) {
        const secret = loadTunnelSecret();
        const proxy = getTunnelProxy();
        if (!secret || !proxy) return;
        const proxyConfig = {
            host: proxy.host,
            port: proxy.port,
            proxyAuth: `${secret.username}:${secret.password}`
        };
        tunnelHttpAgent = tunnel.httpOverHttp({
            proxy: proxyConfig,
            maxSockets: 2000
        });
        tunnelHttpsAgent = tunnel.httpsOverHttp({
            proxy: proxyConfig,
            maxSockets: 2000
        });
        proxyHttpKeepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 2000 });
    }
}

function createTunnelSession({ maxSockets = 1 } = {}) {
    const secret = loadTunnelSecret();
    const proxy = getTunnelProxy();
    if (!secret || !proxy) {
        const session = {
            proxy: null,
            proxyHttpAgent: new http.Agent({ keepAlive: true, maxSockets }),
            proxyHttpsAgent: null
        };
        session.reset = () => {
            try {
                if (session.proxyHttpAgent && typeof session.proxyHttpAgent.destroy === 'function') session.proxyHttpAgent.destroy();
            } catch {}
            session.proxyHttpAgent = new http.Agent({ keepAlive: true, maxSockets });
        };
        session.destroy = () => {
            try {
                if (session.proxyHttpAgent && typeof session.proxyHttpAgent.destroy === 'function') session.proxyHttpAgent.destroy();
            } catch {}
        };
        return session;
    }
    const proxyConfig = {
        host: proxy.host,
        port: proxy.port,
        proxyAuth: `${secret.username}:${secret.password}`
    };
    const session = {
        proxy,
        proxyHttpAgent: new http.Agent({ keepAlive: true, maxSockets }),
        proxyHttpsAgent: tunnel.httpsOverHttp({ proxy: proxyConfig, maxSockets })
    };
    session.reset = () => {
        try {
            if (session.proxyHttpAgent && typeof session.proxyHttpAgent.destroy === 'function') session.proxyHttpAgent.destroy();
        } catch {}
        try {
            if (session.proxyHttpsAgent && typeof session.proxyHttpsAgent.destroy === 'function') session.proxyHttpsAgent.destroy();
        } catch {}
        session.proxyHttpAgent = new http.Agent({ keepAlive: true, maxSockets });
        session.proxyHttpsAgent = tunnel.httpsOverHttp({ proxy: proxyConfig, maxSockets });
    };
    session.destroy = () => {
        try {
            if (session.proxyHttpAgent && typeof session.proxyHttpAgent.destroy === 'function') session.proxyHttpAgent.destroy();
        } catch {}
        try {
            if (session.proxyHttpsAgent && typeof session.proxyHttpsAgent.destroy === 'function') session.proxyHttpsAgent.destroy();
        } catch {}
    };
    return session;
}

function getBufferViaTunnelProxySession(targetUrl, headers = {}, timeoutMs, session) {
    const isHttps = targetUrl.protocol === 'https:';
    if (!session || !session.proxy) {
        const err = new Error('Tunnel proxy session not configured');
        err.isTunnelProxyError = true;
        return Promise.reject(err);
    }
    if (!isHttps) {
        return new Promise((resolve, reject) => {
            const req = http.get(
                {
                    hostname: session.proxy.host,
                    port: session.proxy.port,
                    path: targetUrl.href,
                    headers: {
                        ...headers,
                        Host: targetUrl.host,
                        'Proxy-Authorization': session.proxy.authHeader
                    },
                    agent: session.proxyHttpAgent,
                    timeout: timeoutMs
                },
                (res) => {
                    if (res.statusCode !== 200) {
                        const err = new Error(`Status code: ${res.statusCode}`);
                        err.statusCode = res.statusCode;
                        err.isTunnelProxyError = true;
                        return reject(err);
                    }
                    const chunks = [];
                    res.on('data', (chunk) => chunks.push(chunk));
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                }
            );
            req.on('error', (e) => {
                e.isTunnelProxyError = true;
                reject(e);
            });
            req.on('timeout', () => {
                const err = new Error('Request timeout');
                err.isTunnelProxyError = true;
                req.destroy();
                reject(err);
            });
        });
    }

    return new Promise((resolve, reject) => {
        const req = https.get(
            {
                hostname: targetUrl.hostname,
                port: targetUrl.port || 443,
                path: `${targetUrl.pathname}${targetUrl.search}`,
                headers,
                agent: session.proxyHttpsAgent,
                timeout: timeoutMs
            },
            (res) => {
                if (res.statusCode !== 200) {
                    const err = new Error(`Status code: ${res.statusCode}`);
                    err.statusCode = res.statusCode;
                    err.isTunnelProxyError = true;
                    return reject(err);
                }
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }
        );
        req.on('error', (e) => {
            e.isTunnelProxyError = true;
            reject(e);
        });
        req.on('timeout', () => {
            const err = new Error('Request timeout');
            err.isTunnelProxyError = true;
            req.destroy();
            reject(err);
        });
    });
}

function loadStockListCache() {
    try {
        if (!fs.existsSync(STOCK_LIST_CACHE_PATH)) return null;
        const raw = fs.readFileSync(STOCK_LIST_CACHE_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const stocks = parsed && Array.isArray(parsed.stocks) ? parsed.stocks : null;
        if (!stocks || stocks.length === 0) return null;
        return stocks;
    } catch {
        return null;
    }
}

function normalizeStockList(stocks) {
    const arr = Array.isArray(stocks) ? stocks : [];
    const normalized = [];
    for (const item of arr) {
        if (!item) continue;
        const f12 = item.f12 != null ? String(item.f12) : '';
        const f13 = item.f13 != null ? Number(item.f13) : NaN;
        if (!f12 || !Number.isFinite(f13)) continue;
        const f14 = item.f14 != null ? String(item.f14) : '';
        normalized.push({ f12, f13, f14 });
    }
    normalized.sort((a, b) => (a.f13 - b.f13) || a.f12.localeCompare(b.f12));
    return normalized;
}

function loadStockListSaved() {
    try {
        if (!fs.existsSync(STOCK_LIST_SAVED_PATH)) return null;
        const raw = fs.readFileSync(STOCK_LIST_SAVED_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const stocks = parsed && Array.isArray(parsed.stocks) ? parsed.stocks : null;
        if (!stocks || stocks.length === 0) return null;
        return stocks;
    } catch {
        return null;
    }
}

function saveStockListCache(stocks) {
    try {
        fs.writeFileSync(
            STOCK_LIST_CACHE_PATH,
            JSON.stringify({ updatedAt: Date.now(), stocks }, null, 2),
            'utf8'
        );
    } catch {}
}

function saveStockListSaved(stocks) {
    try {
        fs.writeFileSync(
            STOCK_LIST_SAVED_PATH,
            JSON.stringify({ updatedAt: Date.now(), stocks }, null, 2),
            'utf8'
        );
    } catch {}
    try {
        const codes = Array.isArray(stocks)
            ? stocks
                  .map((x) => (x && x.f12 != null ? String(x.f12).trim() : ''))
                  .filter(Boolean)
            : [];
        if (codes.length) fs.writeFileSync(STOCK_CODE_LIST_PATH, `${codes.join('\n')}\n`, 'utf8');
    } catch {}
}

function shouldPushStockListToGh() {
    if (process.env.STOCK_LIST_PUSH_GH) return process.env.STOCK_LIST_PUSH_GH === 'true';
    return process.env.GITHUB_ACTIONS === 'true';
}

function tryGitCommitAndPushStockList({ message }) {
    if (!shouldPushStockListToGh()) return;
    try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: __dirname, stdio: 'ignore' });
    } catch {
        return;
    }
    try {
        if (process.env.GITHUB_ACTIONS === 'true') {
            let name = '';
            let email = '';
            try {
                name = String(execFileSync('git', ['config', 'user.name'], { cwd: __dirname })).trim();
            } catch {}
            try {
                email = String(execFileSync('git', ['config', 'user.email'], { cwd: __dirname })).trim();
            } catch {}
            if (!name) execFileSync('git', ['config', 'user.name', 'github-actions[bot]'], { cwd: __dirname });
            if (!email) execFileSync('git', ['config', 'user.email', 'github-actions[bot]@users.noreply.github.com'], { cwd: __dirname });
        }
    } catch {}

    const relativePath = path.relative(__dirname, STOCK_LIST_SAVED_PATH).split('\\').join('/');
    let hasChange = false;
    try {
        const status = String(
            execFileSync('git', ['status', '--porcelain', '--', relativePath], { cwd: __dirname })
        ).trim();
        hasChange = !!status;
    } catch {
        return;
    }
    if (!hasChange) return;

    try {
        execFileSync('git', ['add', '--', relativePath], { cwd: __dirname, stdio: 'inherit' });
        execFileSync('git', ['commit', '-m', message], { cwd: __dirname, stdio: 'inherit' });
    } catch {
        return;
    }

    try {
        execFileSync('git', ['push'], { cwd: __dirname, stdio: 'inherit' });
    } catch {}
}

function resolveStockList({ fetchedStocks, savedStocks, cachedStocks }) {
    const baselineStocks = savedStocks || cachedStocks;
    const fetched = Array.isArray(fetchedStocks) ? fetchedStocks : [];
    const baseline = Array.isArray(baselineStocks) ? baselineStocks : null;
    const hasSaved = Array.isArray(savedStocks) && savedStocks.length > 0;

    if (!baseline && fetched.length === 0) {
        return { stocks: [], source: 'empty', updateSaved: false, updateCache: false };
    }
    if (baseline && (fetched.length === 0 || fetched.length < baseline.length)) {
        return {
            stocks: baseline,
            source: savedStocks ? 'saved' : 'cache',
            updateSaved: !hasSaved,
            updateCache: !cachedStocks || cachedStocks.length < baseline.length
        };
    }

    const updateCache = !baseline || fetched.length > baseline.length;
    const updateSaved = !hasSaved || updateCache;
    return { stocks: fetched, source: 'fetched', updateSaved, updateCache };
}

// 全局状�?
let stockData = {
    coreView: "",
    mainBusiness: "",
    concept: "",
    saleLimit: "",
    reducePlan: "",
    investigate: "",
    announcement: "",
    reduceCnt: 0,
    saleLimitCnt: 0,
    investigateCnt: 0,
    announcementCnt: 0
};

// 初始化日�?
if (crawler_config.config.logsFile) {
    crawler_tools.logFileInit();
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

function requestBuffer(targetUrl, { method = 'GET', headers = {}, body = null, timeoutMs = 15000 } = {}) {
    return new Promise((resolve, reject) => {
        const isHttps = targetUrl.protocol === 'https:';
        const client = isHttps ? https : http;
        const agent = isHttps ? httpsAgent : httpAgent;
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
                    const buf = Buffer.concat(chunks);
                    if (res.statusCode !== 200) {
                        const err = new Error(`Status code: ${res.statusCode}`);
                        err.statusCode = res.statusCode;
                        err.body = buf.toString();
                        return reject(err);
                    }
                    resolve(buf);
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

async function cninfoQuery({ seDate, pageNum, pageSize, column, plate }) {
    const url = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
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
        category: '',
        trade: '',
        seDate: String(seDate || ''),
        sortName: 'time',
        sortType: 'desc',
        isHLtitle: 'true'
    });
    const body = data.toString();
    const buf = await requestBuffer(new URL(url), {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        body,
        timeoutMs: CNINFO_TIMEOUT_MS
    });
    const text = buf.toString();
    let j;
    try {
        j = JSON.parse(text);
    } catch {
        j = null;
    }
    if (!j || typeof j !== 'object') {
        const err = new Error('CNINFO invalid JSON');
        err.body = text;
        throw err;
    }
    return j;
}

async function cninfoDailyLatestByStock(dateStr, stockIdSet) {
    const seDate = `${dateStr}~${dateStr}`;
    const seen = new Set();
    const out = new Map();
    const maxPages = Number.isFinite(CNINFO_MAX_PAGES) && CNINFO_MAX_PAGES > 0 ? CNINFO_MAX_PAGES : 1;
    const pageSize = Number.isFinite(CNINFO_PAGE_SIZE) && CNINFO_PAGE_SIZE > 0 ? CNINFO_PAGE_SIZE : 50;
    const targetSize = stockIdSet && stockIdSet.size > 0 ? stockIdSet.size : 0;
    const queries = Array.isArray(CNINFO_QUERIES) && CNINFO_QUERIES.length ? CNINFO_QUERIES : [{ plate: 'sz', column: 'szse' }];

    for (const q of queries) {
        const plate = q && q.plate ? String(q.plate) : '';
        const column = q && q.column ? String(q.column) : 'szse';
        for (let page = 1; page <= maxPages; page += 1) {
            let j;
            try {
                j = await cninfoQuery({ seDate, pageNum: page, pageSize, column, plate });
            } catch (e) {
                console.warn(`CNINFO daily query failed: plate=${plate || 'na'} col=${column} date=${dateStr} page=${page} err=${e && e.message ? e.message : e}`);
                break;
            }
            const items = j && Array.isArray(j.announcements) ? j.announcements : null;
            if (!items || items.length === 0) break;
            for (const item of items) {
                const secCode = String(item.secCode || item.sec_code || '').trim();
                if (!secCode) continue;
                if (stockIdSet && stockIdSet.size > 0 && !stockIdSet.has(secCode)) continue;
                if (seen.has(secCode)) continue;
                seen.add(secCode);
                out.set(secCode, {
                    secCode,
                    secName: String(item.secName || item.sec_name || '').trim(),
                    announcementTimeRaw: item.announcementTime || item.announcement_time || '',
                    announcementTime: formatCninfoTime(item.announcementTime || item.announcement_time || ''),
                    announcementEpochMs: cninfoEpochMs(item.announcementTime || item.announcement_time || '') || 0,
                    announcementTitle: String(item.announcementTitle || item.announcement_title || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
                });
                if (targetSize && seen.size >= targetSize) return out;
            }
        }
    }
    return out;
}

async function cninfoLatestForTodayAndYesterday(stockIdSet) {
    const today = cninfoDateString(0);
    const yesterday = cninfoDateString(-1);
    const todayMap = await cninfoDailyLatestByStock(today, stockIdSet);
    const yMap = await cninfoDailyLatestByStock(yesterday, stockIdSet);

    const merged = new Map();
    for (const [k, v] of todayMap.entries()) merged.set(k, v);
    for (const [k, v] of yMap.entries()) {
        const cur = merged.get(k);
        if (!cur || (v.announcementEpochMs || 0) > (cur.announcementEpochMs || 0)) merged.set(k, v);
    }
    return merged;
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

function formatAnnTime(timeStr) {
    const s = String(timeStr || '').trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (!m) return s;
    const mm = m[2];
    const dd = m[3];
    const hh = m[4];
    const mi = m[5];
    const ss = m[6] || '00';
    const mode = ANN_TIME_FORMAT === 'mmdd' || ANN_TIME_FORMAT === 'mm-dd' || ANN_TIME_FORMAT === 'date'
        ? 'mmdd'
        : (ANN_TIME_FORMAT === 'hhmm' || ANN_TIME_FORMAT === 'hhss' || ANN_TIME_FORMAT === 'time'
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

function llmDebugLog(msg) {
    if (!LLM_DEBUG) return;
    console.log(String(msg || ''));
}

const LLM_USAGE_ACC = { prompt: 0, completion: 0, total: 0, calls: 0 };

function addLlmUsage(usage) {
    if (!usage) return;
    const pt = usage.prompt_tokens != null ? Number(usage.prompt_tokens) : NaN;
    const ct = usage.completion_tokens != null ? Number(usage.completion_tokens) : NaN;
    const tt = usage.total_tokens != null ? Number(usage.total_tokens) : NaN;
    if (![pt, ct].every((n) => Number.isFinite(n) && n >= 0)) return;
    const total = Number.isFinite(tt) && tt >= 0 ? tt : pt + ct;
    LLM_USAGE_ACC.prompt += pt;
    LLM_USAGE_ACC.completion += ct;
    LLM_USAGE_ACC.total += total;
    LLM_USAGE_ACC.calls += 1;
}

function emitLlmUsageSummary() {
    if (!LLM_USAGE_ACC.calls) return;
    process.stdout.write(
        `LLM_USAGE ${JSON.stringify({
            scope: 'crawler',
            model: LLM_MODEL,
            prompt_tokens: LLM_USAGE_ACC.prompt,
            completion_tokens: LLM_USAGE_ACC.completion,
            total_tokens: LLM_USAGE_ACC.total,
            calls: LLM_USAGE_ACC.calls
        })}\n`
    );
}

async function llmSummarizeAnnouncement({ secCode, secName, announcementTime, announcementTitle }, maxChars) {
    const fallback = cutByChars(announcementTitle || '', maxChars);
    if (!LLM_API_KEY) {
        llmDebugLog(`CRAWLER LLM off: missing apiKey sec=${secCode || ''}`);
        return fallback;
    }
    const prompt = `请将以下公告信息改写成一句“财经网站标题风格”的内容要点，不超过${maxChars}个汉字：要求精炼、信息密度高、只写事实不推测/不编造，数字与单位尽量原样保留；不要出现公司名称/简�?股票名称（可用“公司”代替或省略主语）；不要输出标题字样/不要换行。输入：股票:${secCode} 时间:${announcementTime} 标题:${announcementTitle}`;
    const url = `${LLM_BASE_URL}/chat/completions`;
    try {
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
            `CRAWLER LLM req: sec=${secCode || ''} model=${LLM_MODEL} host=${new URL(url).host} promptChars=${String(prompt || '').length} bodyBytes=${Buffer.byteLength(body)}`
        );
        const buf = await requestBuffer(new URL(url), {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${LLM_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            },
            body,
            timeoutMs: Math.max(CNINFO_TIMEOUT_MS, 20000)
        });
        const text = buf.toString();
        let j;
        try {
            j = JSON.parse(text);
        } catch {
            j = null;
        }
        if (j && typeof j === 'object' && j.usage) addLlmUsage(j.usage);
        const tookMs = Date.now() - t0;
        llmDebugLog(`CRAWLER LLM res: sec=${secCode || ''} ms=${tookMs} bytes=${buf.length} json=${j ? 'ok' : 'fail'}`);
        if (!j) {
            llmDebugLog(`CRAWLER LLM resHead: ${cutByChars(text, 220)}`);
        }
        const content = j && j.choices && j.choices[0] && j.choices[0].message ? j.choices[0].message.content : '';
        const s = formatDecimalsInText(cutByChars(content || '', maxChars));
        llmDebugLog(`CRAWLER LLM out: sec=${secCode || ''} outChars=${s.length} fallback=${s ? 'no' : 'yes'}`);
        return s || fallback;
    } catch (e) {
        const sc = e && e.statusCode ? String(e.statusCode) : '';
        console.warn(`LLM summarize failed: ${secCode} status=${sc || 'na'} err=${e && e.message ? e.message : e}`);
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

async function main() {
    try {
        console.log('Starting stock crawling process...');
        const startTimestamp = crawler_tools.timestamp();
        
        const stockList = await getAllStocks();
        if (!stockList || stockList.length === 0) {
            console.log('No stocks found');
            return;
        }
        
        console.log(`Total stock count: ${stockList.length}`);
        if (ONLY_STOCK_LIST) {
            return;
        }
        const maxStocks = MAX_STOCKS;
        const stocksToProcess =
            Number.isFinite(maxStocks) && maxStocks > 0 ? stockList.slice(0, maxStocks) : stockList;
        if (Number.isFinite(maxStocks) && maxStocks > 0) {
            console.log(`MAX_STOCKS enabled: processing ${stocksToProcess.length}/${stockList.length}`);
        } else {
            console.log(`Processing ${stocksToProcess.length} stocks`);
        }

        const stockPrefixMap = new Map();
        const stockIdSet = new Set();
        for (const s of stocksToProcess) {
            const stockId = s && s.f12 ? String(s.f12) : '';
            if (!stockId) continue;
            let exchangeId = s && s.f13 ? String(s.f13) : '';
            if (stockId.startsWith("8") || stockId.startsWith("4") || stockId.startsWith("9")) {
                exchangeId = "2";
            }
            stockIdSet.add(stockId);
            stockPrefixMap.set(stockId, `${exchangeId}|${stockId}`);
        }

        let result = await processStocks(stocksToProcess, {
            label: 'main',
            stockRetryOverrides: IS_CI ? { maxRetries: CI_MAIN_MAX_RETRIES } : null
        });
        let failedStocks = result.failedStocks;
        if (failedStocks.length > 0 && STOCK_RECOVERY_ROUNDS > 0) {
            console.warn(`Main pass failed stocks: ${failedStocks.length}`);
            const recoveryBaseDelay = Math.max(STOCK_RETRY_BASE_DELAY, 800);
            const recoveryMaxDelay = Math.max(STOCK_RETRY_MAX_DELAY, 8000);
            const recoveryTimeout = IS_CI ? CI_RECOVERY_TIMEOUT : Math.max(STOCK_FETCH_TIMEOUT, 15000);
            for (let round = 1; round <= STOCK_RECOVERY_ROUNDS && failedStocks.length > 0; round += 1) {
                console.log(`Recovery round ${round}: ${failedStocks.length}`);
                result = await processStocks(failedStocks, {
                    label: `recovery${round}`,
                    workerCap: STOCK_RECOVERY_WORKER_CAP,
                    sessionPoolSize: Math.min(STOCK_SESSION_POOL_SIZE, 10),
                    stockRetryOverrides: {
                        maxRetries: STOCK_RECOVERY_MAX_RETRIES,
                        baseDelay: recoveryBaseDelay,
                        maxDelay: recoveryMaxDelay,
                        timeoutMs: recoveryTimeout
                    }
                });
                failedStocks = result.failedStocks;
            }
            if (failedStocks.length > 0) {
                console.warn(`Final failed stocks: ${failedStocks.length}`);
            } else {
                console.log('Recovery done: all stocks succeeded');
            }
        }

        if (ENABLE_ANNOUNCEMENTS) {
            try {
                const cninfoLatest = await cninfoLatestForTodayAndYesterday(stockIdSet);
                const annList = Array.from(cninfoLatest.values());
                const summaries = await summarizeWithConcurrency(
                    annList,
                    ANNOUNCEMENT_SUMMARY_CONCURRENCY,
                    async (ann) => llmSummarizeAnnouncement(ann, ANNOUNCEMENT_SUMMARY_CHARS)
                );
                for (let i = 0; i < annList.length; i += 1) {
                    const ann = annList[i];
                    const stockId = ann && ann.secCode ? String(ann.secCode) : '';
                    const prefix = stockPrefixMap.get(stockId);
                    if (!prefix) continue;
                    const timeStr = formatAnnTime(cleanOneLine(ann.announcementTime || ''));
                    const summaryStr = formatDecimalsInText(cleanOneLine(summaries[i] || ''));
                    if (!timeStr || !summaryStr) continue;
                    stockData.announcement += `${prefix}|22|${timeStr} ${summaryStr}|0.000\n`;
                    stockData.announcementCnt++;
                }
                console.log(`公告家数: ${stockData.announcementCnt}`);
            } catch (e) {
                console.warn(`公告抓取失败: ${e && e.message ? e.message : e}`);
            }
        }

        createStockInfoFile();
        
        const endTimestamp = crawler_tools.timestamp();
        const usedTime = (endTimestamp - startTimestamp) / 1000;
        console.log(`Total time used: ${usedTime.toFixed(2)} seconds`);
    } catch (error) {
        console.error('Main process error:', error.message);
    }
}

async function getAllStocks() {
    const savedStocks = loadStockListSaved();
    const cachedStocks = loadStockListCache();
    const allStockIds = [];
    const initialPage = await getStocksByPage(1);
    
    if (!initialPage) return (savedStocks || cachedStocks) || [];
    
    const totalPage = Math.ceil(initialPage.total / 100);
    allStockIds.push(...initialPage.arr);
    
    // 并发获取所有页的数据，限制并发量避免被风控
    const CONCURRENCY_LIMIT = Math.max(1, Math.min(10, STOCK_LIST_CONCURRENCY));
    const pagesToFetch = Array.from({ length: totalPage - 1 }, (_, i) => i + 2);
    
    const sessions = Array.from({ length: CONCURRENCY_LIMIT }, () => createTunnelSession());
    const failedPages = [];
    try {
        for (let i = 0; i < pagesToFetch.length; i += CONCURRENCY_LIMIT) {
            const batchPages = pagesToFetch.slice(i, i + CONCURRENCY_LIMIT);
            const results = await Promise.all(
                batchPages.map((page, idx) => getStocksByPage(page, 0, sessions[idx]))
            );
            
            for (let j = 0; j < results.length; j += 1) {
                const result = results[j];
                const page = batchPages[j];
                if (result) {
                    allStockIds.push(...result.arr);
                } else {
                    failedPages.push(page);
                }
            }
        }

        if (failedPages.length > 0) {
            const RECOVERY_CONCURRENCY_LIMIT = CONCURRENCY_LIMIT;
            const recoverySessions = Array.from(
                { length: RECOVERY_CONCURRENCY_LIMIT },
                () => createTunnelSession()
            );
            try {
                for (let i = 0; i < failedPages.length; i += RECOVERY_CONCURRENCY_LIMIT) {
                    const batchPages = failedPages.slice(i, i + RECOVERY_CONCURRENCY_LIMIT);
                    const results = await Promise.all(
                        batchPages.map((page, idx) => getStocksByPage(page, 0, recoverySessions[idx]))
                    );
                    for (const result of results) {
                        if (result) {
                            allStockIds.push(...result.arr);
                        }
                    }
                }
            } finally {
                for (const session of recoverySessions) {
                    if (session && typeof session.destroy === 'function') session.destroy();
                }
            }
        }
    } finally {
        for (const session of sessions) {
            if (session && typeof session.destroy === 'function') session.destroy();
        }
    }

    const dedupedMap = new Map();
    for (const stock of allStockIds) {
        const key = stock && stock.f12 ? `${stock.f13}|${stock.f12}` : null;
        if (!key) continue;
        if (!dedupedMap.has(key)) dedupedMap.set(key, stock);
    }
    const dedupedStocks = normalizeStockList(Array.from(dedupedMap.values()));
    
    const decision = resolveStockList({
        fetchedStocks: dedupedStocks,
        savedStocks,
        cachedStocks
    });
    const baselineStocks = savedStocks || cachedStocks;
    if ((decision.source === 'saved' || decision.source === 'cache') && baselineStocks) {
        console.warn(
            `Fetched stock list size (${dedupedStocks.length}) smaller than saved (${baselineStocks.length}); using saved list.`
        );
    }

    if (decision.updateSaved) {
        saveStockListSaved(decision.stocks);
        saveStockListCache(decision.stocks);
        tryGitCommitAndPushStockList({
            message: `Update stock list (${decision.stocks.length})`
        });
    } else if (decision.updateCache) {
        saveStockListCache(decision.stocks);
    }
    return decision.stocks;
}

async function getStocksByPage(page, retryCount = 0, session) {
    const MAX_RETRIES = page === 1 ? 51 : 3;
    const RETRY_DELAY = page === 1 ? 0 : 1200;
    
    try {
        const hosts = [
            "51.push2.eastmoney.com",
            "push2delay.eastmoney.com",
            "push2.eastmoney.com"
        ];
        const host = hosts[retryCount % hosts.length];
        const path = `/api/qt/clist/get?pn=${page}&pz=100&po=1&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048,m:0+t:83&fields=f12,f13,f14`;
        
        const options = {
            hostname: host,
            path: path,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'zh-CN,zh;q=0.9',
                'Connection': 'keep-alive'
            },
            timeout: 15000,
            port: 80
        };
        
        const data = await fetchData(options, session);
        if (!data || !data.data || !data.data.diff) {
            throw new Error('Invalid API response structure');
        }
        
        return {
            arr: Object.values(data.data.diff),
            total: data.data.total || 0
        };
    } catch (error) {
        logDetail(`Page ${page} error: ${error.message}`);
        const statusCode = error && typeof error.statusCode === 'number' ? error.statusCode : null;
        const isBlocked = statusCode === 517 || statusCode === 403 || statusCode === 429 || statusCode === 503;
        if (isBlocked) {
            preferTunnelProxyFor(TUNNEL_ON_BLOCKED_MS);
        }
        if (error && error.isTunnelProxyError && session && typeof session.reset === 'function') {
            session.reset();
            markTunnelProxyFailure({ resetGlobalAgents: false });
        }
        if (retryCount < MAX_RETRIES) {
            logDetail(`Retrying page ${page} (attempt ${retryCount + 1})...`);
            if (RETRY_DELAY > 0) {
                const delay = RETRY_DELAY + Math.floor(Math.random() * 300);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
            return getStocksByPage(page, retryCount + 1, session);
        }
        logDetail(`Failed to fetch page ${page} after ${MAX_RETRIES} attempts`);
        return null;
    }
}

async function processStocks(stockList, opts = {}) {
    const label = opts && opts.label ? String(opts.label) : '';
    const totalStocks = stockList.length;
    const workerCap = opts && Number.isFinite(opts.workerCap) ? Number(opts.workerCap) : STOCK_WORKER_CAP;
    const sessionPoolSize =
        opts && Number.isFinite(opts.sessionPoolSize) ? Number(opts.sessionPoolSize) : STOCK_SESSION_POOL_SIZE;
    const stockRetryOverrides =
        opts && opts.stockRetryOverrides && typeof opts.stockRetryOverrides === 'object'
            ? opts.stockRetryOverrides
            : null;
    const workerCount = Math.max(1, Math.min(totalStocks, TASK_COUNT, workerCap));
    const minConcurrency = Math.max(1, Math.min(workerCount, ADAPTIVE_MIN_WORKERS));
    let currentConcurrency =
        ADAPTIVE_CONCURRENCY_ENABLED && process.env.GITHUB_ACTIONS === 'true' ? minConcurrency : workerCount;
    const adaptiveWindowSize = Math.max(50, ADAPTIVE_WINDOW_SIZE);
    const poolSize = Math.max(1, Math.min(workerCount, sessionPoolSize));
    const maxSocketsPerSession = Math.max(1, Math.ceil(workerCount / poolSize));
    const sessions = Array.from({ length: poolSize }, () =>
        createTunnelSession({ maxSockets: maxSocketsPerSession })
    );
    const failedStocks = [];
    let idx = 0;
    let finishedCount = 0;
    let nextSleepAt = TASK_SLEEP_COUNT > 0 ? TASK_SLEEP_COUNT : Infinity;
    let sleepPromise = null;
    let successCount = 0;
    let failCount = 0;
    const startedAt = Date.now();
    let lastTickAt = startedAt;
    let lastFinishedCount = 0;
    let lastProgressAt = startedAt;
    let stallResetAt = 0;
    let lastAdjustAt = 0;
    let pauseUntil = 0;
    let lastSevereAt = 0;
    const recent = [];
    let recentFail = 0;
    let recentNetErr = 0;

    const pushRecent = ({ ok, netErr }) => {
        const item = { ok: !!ok, netErr: !!netErr };
        recent.push(item);
        if (!item.ok) recentFail += 1;
        if (item.netErr) recentNetErr += 1;
        while (recent.length > adaptiveWindowSize) {
            const old = recent.shift();
            if (old && !old.ok) recentFail -= 1;
            if (old && old.netErr) recentNetErr -= 1;
        }
    };

    const maybeSleep = async () => {
        if (SLEEP_TIME <= 0) return;
        if (finishedCount < nextSleepAt) return;
        if (!sleepPromise) {
            sleepPromise = new Promise((resolve) => setTimeout(resolve, SLEEP_TIME)).finally(() => {
                sleepPromise = null;
            });
            nextSleepAt += TASK_SLEEP_COUNT;
        }
        await sleepPromise;
    };

    const tick = () => {
        const now = Date.now();
        const elapsedMs = now - startedAt;
        const deltaMs = now - lastTickAt;
        const finishedDelta = finishedCount - lastFinishedCount;
        const rate = deltaMs > 0 ? (finishedDelta * 1000) / deltaMs : 0;
        const avgRate = elapsedMs > 0 ? (finishedCount * 1000) / elapsedMs : 0;
        const percent = totalStocks > 0 ? Math.min(100, (finishedCount / totalStocks) * 100) : 0;
        const prefix = label ? `${label} ` : '';
        const windowN = recent.length;
        const windowFailRate = windowN > 0 ? recentFail / windowN : 0;
        const windowNetErrRate = windowN > 0 ? recentNetErr / windowN : 0;
        console.log(
            `${prefix}Progress: ${percent.toFixed(2)}% (${finishedCount}/${totalStocks}) ok=${successCount} fail=${failCount} conc=${currentConcurrency}/${workerCount} rate=${rate.toFixed(2)}/s avg=${avgRate.toFixed(2)}/s winFail=${(windowFailRate * 100).toFixed(1)}% winNetErr=${(windowNetErrRate * 100).toFixed(1)}%`
        );
        if (finishedDelta > 0) {
            lastProgressAt = now;
        }
        if (ADAPTIVE_CONCURRENCY_ENABLED && windowN >= 50 && now - lastAdjustAt >= ADAPTIVE_ADJUST_COOLDOWN_MS) {
            if (windowNetErrRate >= ADAPTIVE_HANGUP_HIGH || windowFailRate >= 0.25) {
                const next = Math.max(minConcurrency, Math.floor(currentConcurrency * 0.8));
                if (next !== currentConcurrency) {
                    currentConcurrency = next;
                    lastAdjustAt = now;
                    console.warn(`${prefix}Concurrency down: ${currentConcurrency}/${workerCount}`);
                }
            } else if (windowNetErrRate <= ADAPTIVE_HANGUP_LOW && windowFailRate <= 0.08) {
                const step = Math.max(1, Math.floor(workerCount * 0.05));
                const next = Math.min(workerCount, currentConcurrency + step);
                if (next !== currentConcurrency) {
                    currentConcurrency = next;
                    lastAdjustAt = now;
                    console.log(`${prefix}Concurrency up: ${currentConcurrency}/${workerCount}`);
                }
            }
        }
        if (
            ADAPTIVE_CONCURRENCY_ENABLED &&
            windowN >= 100 &&
            currentConcurrency === minConcurrency &&
            windowNetErrRate >= ADAPTIVE_SEVERE_NETERR &&
            now - lastSevereAt >= ADAPTIVE_PAUSE_MS
        ) {
            lastSevereAt = now;
            pauseUntil = Math.max(pauseUntil, now + ADAPTIVE_PAUSE_MS);
            console.warn(`${prefix}Severe net errors; pausing ${ADAPTIVE_PAUSE_MS}ms and resetting sessions/agents...`);
            for (const session of sessions) {
                if (session && typeof session.reset === 'function') session.reset();
            }
            resetTunnelAgents();
            if (IS_CI && CI_DIRECT_FALLBACK) {
                temporarilyDisableTunnelProxy(CI_DIRECT_FALLBACK_MS);
            }
        }
        if (
            finishedCount < totalStocks &&
            now - lastProgressAt >= STOCK_STALL_RESET_MS &&
            now - stallResetAt >= STOCK_STALL_RESET_MS
        ) {
            stallResetAt = now;
            console.warn('No progress detected; resetting tunnel sessions/agents...');
            for (const session of sessions) {
                if (session && typeof session.reset === 'function') session.reset();
            }
            resetTunnelAgents();
        }
        lastTickAt = now;
        lastFinishedCount = finishedCount;
    };
    const ticker = setInterval(tick, 5000);

    const workers = Array.from({ length: workerCount }, (_, workerIdx) =>
        (async () => {
            const session = sessions[workerIdx % poolSize];
            while (true) {
                if (idx >= totalStocks) return;
                if (ADAPTIVE_CONCURRENCY_ENABLED && workerIdx >= currentConcurrency) {
                    await new Promise((resolve) => setTimeout(resolve, 200));
                    continue;
                }
                if (pauseUntil && Date.now() < pauseUntil) {
                    await new Promise((resolve) => setTimeout(resolve, 250));
                    continue;
                }
                const i = idx;
                idx += 1;
                if (i >= totalStocks) return;

                await maybeSleep();

                const stock = stockList[i];
                const stockId = stock.f12;
                let exchangeId = stock.f13;

                if (stockId.startsWith("8") || stockId.startsWith("4") || stockId.startsWith("9")) {
                    exchangeId = "2";
                }

                const result = await getStockInfo(stockId, exchangeId, session, stockRetryOverrides);
                const ok = !!(result && result.ok);
                const netErr = !!(result && (result.hangup || result.timeout || result.hardTimeout));
                pushRecent({ ok, netErr });
                if (ok) {
                    successCount += 1;
                } else {
                    failCount += 1;
                    failedStocks.push({ f12: stockId, f13: exchangeId });
                }

                finishedCount += 1;
                const step = totalStocks > 0 ? Math.ceil(totalStocks * 0.10) : 100;
                if (finishedCount % step === 0 || finishedCount === totalStocks) {
                    const percent = Math.min(100, (finishedCount / totalStocks) * 100);
                    const prefix = label ? `${label} ` : '';
                    console.log(`${prefix}Progress: ${percent.toFixed(2)}% completed`);
                }
            }
        })()
    );

    try {
        await Promise.all(workers);
    } finally {
        clearInterval(ticker);
        tick();
        for (const session of sessions) {
            if (session && typeof session.destroy === 'function') session.destroy();
        }
    }

    return { failedStocks, successCount, failCount };
}

async function processBatch(batch) {
    const workerCount = Math.max(1, Math.min(batch.length, TASK_COUNT, 20));
    const sessions = Array.from({ length: workerCount }, () => createTunnelSession());
    let idx = 0;

    const workers = sessions.map((session) =>
        (async () => {
            while (true) {
                const i = idx;
                idx += 1;
                if (i >= batch.length) return;

                const stock = batch[i];
                const stockId = stock.f12;
                let exchangeId = stock.f13;

                if (stockId.startsWith("8") || stockId.startsWith("4") || stockId.startsWith("9")) {
                    exchangeId = "2";
                }

                await getStockInfo(stockId, exchangeId, session);
            }
        })()
    );

    try {
        await Promise.all(workers);
    } finally {
        for (const session of sessions) {
            if (session && typeof session.destroy === 'function') session.destroy();
        }
    }
}

async function getStockInfo(stockId, exchangeId, session, overrides = null) {
    const MAX_RETRIES =
        overrides && Number.isFinite(overrides.maxRetries) ? Number(overrides.maxRetries) : STOCK_MAX_RETRIES;
    const fetchTimeoutMs =
        overrides && Number.isFinite(overrides.timeoutMs) ? Number(overrides.timeoutMs) : STOCK_FETCH_TIMEOUT_EFFECTIVE;
    const baseDelayMs =
        overrides && Number.isFinite(overrides.baseDelay) ? Number(overrides.baseDelay) : STOCK_RETRY_BASE_DELAY;
    const maxDelayMs =
        overrides && Number.isFinite(overrides.maxDelay) ? Number(overrides.maxDelay) : STOCK_RETRY_MAX_DELAY;
    let lastReason = 'unknown';
    let lastStatusCode = null;
    let hadHangup = false;
    let hadTimeout = false;
    let hadHardTimeout = false;
    let hadBlocked = false;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const url = `http://basic.10jqka.com.cn/${stockId}/`;
            const html = await withHardTimeout(
                fetchHtml(url, fetchTimeoutMs, session),
                fetchTimeoutMs + 3000,
                { isTunnelProxyError: shouldPreferTunnelProxy() && isTunnelProxyEnabled() }
            );
            
            if (!html || html.length < 500) {
                const err = new Error(`Empty or invalid HTML response (length: ${html ? html.length : 0})`);
                err.isTunnelProxyError = shouldPreferTunnelProxy() && isTunnelProxyEnabled();
                throw err;
            }
            
            const $ = cheerio.load(html);
            const stockPrefix = `${exchangeId}|${stockId}`;
            const coreViewText = crawler_tools.str_trim($('span.core-view-text').text());
            const mainBusinessText = crawler_tools.str_trim(
                $('span.main-bussiness-text').find('a.newtaid').text()
            );
            if (!coreViewText && !mainBusinessText) {
                const blocked = /验证码|captcha|安全验证|访问过于频繁|安全检测/i.test(html);
                if (blocked) {
                    const err = new Error('Blocked HTML response');
                    err.isTunnelProxyError = shouldPreferTunnelProxy() && isTunnelProxyEnabled();
                    throw err;
                }
            }
            
            // 提取核心信息
            stockData.coreView += `${stockPrefix}|9|${coreViewText}|0.000\n`;
            stockData.mainBusiness += `${stockPrefix}|8|${mainBusinessText}|0.000\n`;
            
            // 提取概念信息
            const concepts = [];
            $('div.newconcept a.newtaid').not('a.alltext').each((index, element) => {
                concepts.push(crawler_tools.str_trim($(element).text()));
            });
            stockData.concept += `${stockPrefix}|18|${concepts.join(',')}|0.000\n`;
            
            // 提取特殊事件信息
            extractSpecialEvents($, stockPrefix);
            
            onTunnelProxySuccess();
            return {
                ok: true,
                reason: lastReason,
                statusCode: lastStatusCode,
                hangup: hadHangup,
                timeout: hadTimeout,
                hardTimeout: hadHardTimeout,
                blocked: hadBlocked
            };
        } catch (error) {
            logErrorDetail(`Stock ${stockId} attempt ${attempt} error: ${error.message}`);
            const statusCode = error && typeof error.statusCode === 'number' ? error.statusCode : null;
            lastStatusCode = statusCode;
            const isBlocked = statusCode === 517 || statusCode === 403 || statusCode === 429 || statusCode === 503;
            const msg = error && error.message ? String(error.message) : '';
            if (isBlocked) {
                hadBlocked = true;
                lastReason = 'blocked';
                preferTunnelProxyFor(TUNNEL_ON_BLOCKED_MS);
            } else if (statusCode && statusCode >= 500) {
                lastReason = 'http_5xx';
            } else if (msg.includes('socket hang up')) {
                hadHangup = true;
                lastReason = 'socket_hang_up';
            } else if (msg.includes('ECONNRESET') || msg.includes('read ECONNRESET')) {
                hadHangup = true;
                lastReason = 'conn_reset';
            } else if (msg.includes('Request timeout')) {
                hadTimeout = true;
                lastReason = 'timeout';
            } else if (msg.includes('Hard timeout')) {
                hadHardTimeout = true;
                lastReason = 'hard_timeout';
            } else if (msg.includes('Blocked HTML response')) {
                hadBlocked = true;
                lastReason = 'blocked_html';
                preferTunnelProxyFor(TUNNEL_ON_BLOCKED_MS);
            } else if (msg.includes('Missing required HTML fields')) {
                lastReason = 'invalid_html';
            } else {
                lastReason = 'other';
            }
            if ((error && error.isTunnelProxyError) && session && typeof session.reset === 'function') {
                session.reset();
                markTunnelProxyFailure({ resetGlobalAgents: false });
            }
            if (attempt < MAX_RETRIES) {
                let delay = Math.min(
                    maxDelayMs,
                    baseDelayMs * Math.pow(2, attempt - 1)
                );
                if (isBlocked) {
                    delay = Math.min(maxDelayMs, Math.max(delay, 800 * attempt));
                }
                delay += Math.floor(Math.random() * 200);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    
    logErrorDetail(`Failed to fetch stock ${stockId} after ${MAX_RETRIES} attempts`);
    return {
        ok: false,
        reason: lastReason,
        statusCode: lastStatusCode,
        hangup: hadHangup,
        timeout: hadTimeout,
        hardTimeout: hadHardTimeout,
        blocked: hadBlocked
    };
}

function extractSpecialEvents($, stockPrefix) {
    $('div.new_msg div.overview table tr').each((index, element) => {
        if (index >= 20) return false; // 最多读�?0�?
        
        const title = crawler_tools.str_trim($(element).find('td strong.hltip').text());
        if (!title) return;
        
        if (STOCK_SALE_LIMIT_REGEX.test(title)) {
            processSaleLimit($(element), $, stockPrefix);
            return false;
        } else if (STOCK_REDUCE_REGEX.test(title)) {
            processReducePlan($(element), $, stockPrefix);
            return false;
        } else if (STOCK_INVESTIGATE_REGEX.test(title)) {
            processInvestigate($(element), $, stockPrefix);
            return false;
        }
    });
}

function processSaleLimit(element, $, stockPrefix) {
    const date = crawler_tools.str_trim(element.find('td:first-child').text());
    const text = crawler_tools.str_trim(element.find('td a:first-child').text());
    
    const formattedDate = date.length > 10 ? "今天" : date;
    const detail = `${formattedDate} ${text}`;
    
    stockData.saleLimit += `${stockPrefix}|19|${detail}|0.000\n`;
    stockData.saleLimitCnt++;
}

function processReducePlan(element, $, stockPrefix) {
    const text = crawler_tools.str_trim(element.find('td span').text());
    stockData.reducePlan += `${stockPrefix}|20|${text}|0.000\n`;
    stockData.reduceCnt++;
}

function processInvestigate(element, $, stockPrefix) {
    let text = crawler_tools.str_trim(element.find('td span').text());
    text = text.replace(/[\r\n]+/g, "").replace(/\s+/g, "");
    
    const index = text.indexOf('...');
    if (index !== -1) text = text.substring(0, index);
    
    const detailIndex = text.indexOf('详细内容');
    if (detailIndex !== -1) text = text.substring(0, detailIndex);
    
    stockData.investigate += `${stockPrefix}|21|${text}|0.000\n`;
    stockData.investigateCnt++;
}

function createStockInfoFile() {
    const content = [
        stockData.mainBusiness,
        stockData.coreView,
        stockData.concept,
        stockData.saleLimit,
        stockData.reducePlan,
        stockData.investigate,
        stockData.announcement
    ].join('');
    
    const backupPath = getBackupFilePath();
    try {
        if (fs.existsSync(STOCK_INFO_FILE_PATH)) {
            fs.renameSync(STOCK_INFO_FILE_PATH, backupPath);
        }
    } catch (err) {
        console.error('Backup error:', err.message);
    }
    
    try {
        const gbkContent = iconv.encode(content, 'GBK');
        fs.writeFileSync(STOCK_INFO_FILE_PATH, gbkContent);
        console.log(`File created: ${STOCK_INFO_FILE_PATH}`);
        let lineCount = 0;
        for (const b of gbkContent) {
            if (b === 10) lineCount += 1;
        }
        console.log(`Line count: ${lineCount}`);
        
        console.log(`减持家数: ${stockData.reduceCnt}`);
        console.log(`解禁家数: ${stockData.saleLimitCnt}`);
        console.log(`立案家数: ${stockData.investigateCnt}`);
    } catch (err) {
        console.error('File write error:', err.message);
    }
}

function getBackupFilePath() {
    const ext = path.extname(STOCK_INFO_FILE_PATH);
    const base = STOCK_INFO_FILE_PATH.slice(0, -ext.length);
    return `${base}_${crawler_tools.timestamp()}${ext}`;
}

function withHardTimeout(promise, timeoutMs, { isTunnelProxyError = false } = {}) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            const err = new Error('Hard timeout');
            if (isTunnelProxyError) err.isTunnelProxyError = true;
            reject(err);
        }, timeoutMs);
        promise.then(
            (v) => {
                clearTimeout(timer);
                resolve(v);
            },
            (e) => {
                clearTimeout(timer);
                reject(e);
            }
        );
    });
}

async function fetchData(options, session) {
    const protocol = options.port === 443 ? 'https:' : 'http:';
    const targetUrl = new URL(`${protocol}//${options.hostname}${options.path}`);
    const buffer = await getBufferWithTunnelPolicy(targetUrl, options.headers, options.timeout, session);
    let str = buffer.toString();
    // Some endpoints may return JSONP like `callback({...})` if requested poorly, 
    // try to clean it up just in case, though Eastmoney mostly returns JSON with right params
    if (str && str.startsWith('jQuery')) {
        const firstParen = str.indexOf('(');
        const lastParen = str.lastIndexOf(')');
        if (firstParen !== -1 && lastParen !== -1) {
            str = str.substring(firstParen + 1, lastParen);
        }
    }
    try {
        return JSON.parse(str);
    } catch (e) {
        throw e;
    }
}

async function fetchHtml(url, timeoutMs = 15000, session) {
    const targetUrl = new URL(url);
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Connection': 'keep-alive'
    };
    const buffer = await getBufferWithTunnelPolicy(targetUrl, headers, timeoutMs, session);
    return iconv.decode(buffer, 'GBK');
}

if (require.main === module) {
    main()
        .catch((e) => {
            console.error(e);
            process.exitCode = 1;
        })
        .finally(() => {
            emitLlmUsageSummary();
        });
}

module.exports = {
    fetchData,
    fetchHtml,
    getAllStocks,
    _tunnelProxyState: {
        isEnabled: () => isTunnelProxyEnabled(),
        getFailureCount: () => tunnelProxyFailureCount
    },
    _stockList: {
        normalize: normalizeStockList,
        loadSaved: loadStockListSaved,
        resolve: resolveStockList
    }
};
