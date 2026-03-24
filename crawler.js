const http = require("http");
const https = require('https');
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const fs = require("fs");
const path = require("path");
const { Buffer } = require('buffer');
const { URL } = require('url');

const crawler_config = require('./crawler-config');
const crawler_tools = require('./crawler-tools');

const TUNNEL = "x811.kdltps.com:15818";
const USERNAME = "t17263192885432";
const PASSWORD = "dgoqlsul";
const MAX_TUNNEL_PROXY_FAILURES = 5;

let tunnelProxyFailureCount = 0;
let tunnelProxyDisabled = false;

function getTunnelProxy() {
    const [host, portStr] = String(TUNNEL).split(':');
    const port = Number(portStr);
    const token = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
    return {
        host,
        port,
        authHeader: `Basic ${token}`
    };
}

function onTunnelProxySuccess() {
    tunnelProxyFailureCount = 0;
}

function onTunnelProxyFailure() {
    tunnelProxyFailureCount += 1;
    if (!tunnelProxyDisabled && tunnelProxyFailureCount >= MAX_TUNNEL_PROXY_FAILURES) {
        tunnelProxyDisabled = true;
        console.warn(`Tunnel proxy disabled after ${tunnelProxyFailureCount} failures; falling back to direct connection.`);
    }
}

function isTunnelProxyEnabled() {
    return !tunnelProxyDisabled;
}

function getBufferDirect(targetUrl, headers = {}, timeoutMs) {
    return new Promise((resolve, reject) => {
        const isHttps = targetUrl.protocol === 'https:';
        const client = isHttps ? https : http;
        const req = client.get(
            {
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                path: `${targetUrl.pathname}${targetUrl.search}`,
                headers,
                timeout: timeoutMs
            },
            (res) => {
                if (res.statusCode !== 200) {
                    return reject(new Error(`Status code: ${res.statusCode}`));
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
    const proxy = getTunnelProxy();
    const isHttps = targetUrl.protocol === 'https:';

    if (!isHttps) {
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
                    timeout: timeoutMs
                },
                (res) => {
                    if (res.statusCode === 407) {
                        const err = new Error(`Proxy authentication required (status code: ${res.statusCode})`);
                        err.isTunnelProxyError = true;
                        return reject(err);
                    }
                    if (res.statusCode !== 200) {
                        return reject(new Error(`Status code: ${res.statusCode}`));
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
        const targetPort = targetUrl.port || 443;
        const connectReq = http.request({
            hostname: proxy.host,
            port: proxy.port,
            method: 'CONNECT',
            path: `${targetUrl.hostname}:${targetPort}`,
            headers: {
                'Proxy-Authorization': proxy.authHeader
            }
        });

        connectReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                const err = new Error(`Proxy CONNECT failed (status code: ${res.statusCode})`);
                err.isTunnelProxyError = true;
                socket.destroy();
                return reject(err);
            }

            const req = https.request(
                {
                    hostname: targetUrl.hostname,
                    port: targetPort,
                    method: 'GET',
                    path: `${targetUrl.pathname}${targetUrl.search}`,
                    headers,
                    socket,
                    agent: false,
                    timeout: timeoutMs
                },
                (res2) => {
                    if (res2.statusCode !== 200) {
                        return reject(new Error(`Status code: ${res2.statusCode}`));
                    }

                    const chunks = [];
                    res2.on('data', (chunk) => chunks.push(chunk));
                    res2.on('end', () => resolve(Buffer.concat(chunks)));
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
            req.end();
        });

        connectReq.on('error', (e) => {
            e.isTunnelProxyError = true;
            reject(e);
        });
        if (timeoutMs) {
            connectReq.setTimeout(timeoutMs, () => {
                const err = new Error('Proxy CONNECT timeout');
                err.isTunnelProxyError = true;
                connectReq.destroy(err);
            });
        }
        connectReq.end();
    });
}

async function getBufferWithTunnelPolicy(targetUrl, headers = {}, timeoutMs) {
    if (!isTunnelProxyEnabled()) {
        return getBufferDirect(targetUrl, headers, timeoutMs);
    }

    try {
        const data = await getBufferViaTunnelProxy(targetUrl, headers, timeoutMs);
        onTunnelProxySuccess();
        return data;
    } catch (e) {
        if (e && e.isTunnelProxyError) {
            onTunnelProxyFailure();
        }
        throw e;
    }
}

// 配置常量
const STOCK_INFO_FILE_PATH = crawler_config.config.filePath;
const SLEEP_TIME = crawler_config.config.sleepTime;
const TASK_COUNT = crawler_config.config.taksCount;
const TASK_SLEEP_COUNT = crawler_config.config.taskSleepCount;
const MAX_COUNT = crawler_config.config.maxCount;

// 正则表达式常量
const STOCK_SALE_LIMIT_REGEX = /预计解除限售|限售解禁/;
const STOCK_REDUCE_REGEX = /增减持计划/;
const STOCK_INVESTIGATE_REGEX = /立案调查/;

// 全局状态
let stockData = {
    coreView: "",
    mainBusiness: "",
    concept: "",
    saleLimit: "",
    reducePlan: "",
    investigate: "",
    reduceCnt: 0,
    saleLimitCnt: 0,
    investigateCnt: 0
};

let taskFinishedCount = 0;

// 初始化日志
if (crawler_config.config.logsFile) {
    crawler_tools.logFileInit();
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
        await processStocks(stockList);
        
        createStockInfoFile();
        
        const endTimestamp = crawler_tools.timestamp();
        const usedTime = (endTimestamp - startTimestamp) / 1000;
        console.log(`Total time used: ${usedTime.toFixed(2)} seconds`);
    } catch (error) {
        console.error('Main process error:', error.message);
    }
}

async function getAllStocks() {
    const allStockIds = [];
    const initialPage = await getStocksByPage(1);
    
    if (!initialPage) return [];
    
    const totalPage = Math.ceil(initialPage.total / 100);
    allStockIds.push(...initialPage.arr);
    
    for (let page = 2; page <= totalPage; page++) {
        const result = await getStocksByPage(page);
        if (result) {
            allStockIds.push(...result.arr);
        }
    }
    
    return allStockIds;
}

async function getStocksByPage(page, retryCount = 0) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 5000; // 5秒
    
    try {
        const host = "push2delay.eastmoney.com";
        const path = `/api/qt/clist/get?pn=${page}&pz=100&po=1&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048,m:0+t:83&fields=f12,f13`;
        
        const options = {
            hostname: host,
            path: path,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json',
                'Referer': 'https://quote.eastmoney.com/',
                'Connection': 'keep-alive'
            },
            timeout: 15000
        };
        
        const data = await fetchData(options);
        if (!data || !data.data || !data.data.diff) {
            throw new Error('Invalid API response structure');
        }
        
        return {
            arr: Object.values(data.data.diff),
            total: data.data.total || 0
        };
    } catch (error) {
        console.error(`Page ${page} error: ${error.message}`);
        if (retryCount < MAX_RETRIES) {
            console.log(`Retrying page ${page} (attempt ${retryCount + 1})...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            return getStocksByPage(page, retryCount + 1);
        }
        console.error(`Failed to fetch page ${page} after ${MAX_RETRIES} attempts`);
        return null;
    }
}

async function processStocks(stockList) {
    const totalStocks = stockList.length;
    const batches = Math.ceil(totalStocks / TASK_COUNT);
    
    for (let i = 0; i < batches; i++) {
        const startIdx = i * TASK_COUNT;
        const endIdx = Math.min(startIdx + TASK_COUNT, totalStocks);
        const batch = stockList.slice(startIdx, endIdx);
        
        await processBatch(batch);
        
        taskFinishedCount += batch.length;
        const percent = Math.min(100, (taskFinishedCount / totalStocks) * 100);
        console.log(`Progress: ${percent.toFixed(2)}% completed`);
        
        // 休眠控制
        if (SLEEP_TIME > 0 && (i % TASK_SLEEP_COUNT === 0) && i > 0) {
            console.log(`Sleeping for ${SLEEP_TIME / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, SLEEP_TIME));
        }
    }
}

async function processBatch(batch) {
    const promises = batch.map(stock => {
        const stockId = stock.f12;
        let exchangeId = stock.f13;
        
        if (stockId.startsWith("8") || stockId.startsWith("4") || stockId.startsWith("9")) {
            exchangeId = "2";
        }
        
        return getStockInfo(stockId, exchangeId);
    });
    
    await Promise.all(promises);
}

async function getStockInfo(stockId, exchangeId) {
    const MAX_RETRIES = 2;
    const RETRY_DELAY = 3000; // 3秒
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const url = `http://basic.10jqka.com.cn/${stockId}/`;
            const html = await fetchHtml(url);
            
            if (!html) {
                throw new Error('Empty HTML response');
            }
            
            const $ = cheerio.load(html);
            const stockPrefix = `${exchangeId}|${stockId}`;
            
            // 提取核心信息
            stockData.coreView += `${stockPrefix}|9|${crawler_tools.str_trim($('span.core-view-text').text())}|0.000\n`;
            stockData.mainBusiness += `${stockPrefix}|8|${crawler_tools.str_trim($('span.main-bussiness-text').find('a.newtaid').text())}|0.000\n`;
            
            // 提取概念信息
            const concepts = [];
            $('div.newconcept a.newtaid').not('a.alltext').each((index, element) => {
                concepts.push(crawler_tools.str_trim($(element).text()));
            });
            stockData.concept += `${stockPrefix}|18|${concepts.join(',')}|0.000\n`;
            
            // 提取特殊事件信息
            extractSpecialEvents($, stockPrefix);
            
            return; // 成功则退出
        } catch (error) {
            console.error(`Stock ${stockId} attempt ${attempt} error: ${error.message}`);
            if (attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
    }
    
    console.error(`Failed to fetch stock ${stockId} after ${MAX_RETRIES} attempts`);
}

function extractSpecialEvents($, stockPrefix) {
    $('div.new_msg div.overview table tr').each((index, element) => {
        if (index >= 20) return false; // 最多读取20行
        
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
    
    const index = text.indexOf('▼');
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
        stockData.investigate
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

async function fetchData(options) {
    const protocol = options.port === 443 ? 'https:' : 'http:';
    const targetUrl = new URL(`${protocol}//${options.hostname}${options.path}`);
    const buffer = await getBufferWithTunnelPolicy(targetUrl, options.headers, options.timeout);
    return JSON.parse(buffer.toString());
}

async function fetchHtml(url, timeoutMs = 15000) {
    const targetUrl = new URL(url);
    const buffer = await getBufferWithTunnelPolicy(targetUrl, {}, timeoutMs);
    return iconv.decode(buffer, 'GBK');
}

if (require.main === module) {
    main().catch(console.error);
}

module.exports = {
    fetchData,
    fetchHtml,
    _tunnelProxyState: {
        isEnabled: () => isTunnelProxyEnabled(),
        getFailureCount: () => tunnelProxyFailureCount
    }
};
