const { exec } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const tunnel = require('tunnel');

// 配置参数
const MAX_RETRIES = 5;         // 最大重试次数
const RETRY_INTERVAL = 120000;   // 重试间隔(毫秒)
const EXEC_TIMEOUT = 1800000;   // 执行超时时间(30分钟)
const SUCCESS_FLAG = 'created'; // 成功标识
const SERVERCHAN_KEY = process.env.SERVERCHAN_KEY; // 从环境变量获取Server酱密钥
const LLM_MODEL = process.env.KIMI_MODEL || process.env.LLM_MODEL || 'kimi-k2-turbo-preview';
const LLM_BASE_URL = (process.env.KIMI_BASE_URL || process.env.LLM_BASE_URL || 'https://api.moonshot.cn/v1').replace(/\/+$/, '');
const LLM_API_KEY = process.env.KIMI_API_KEY || process.env.LLM_API_KEY || '';
const LLM_DEBUG = ['1', 'true', 'yes', 'on'].includes(String(process.env.KIMI_DEBUG || process.env.LLM_DEBUG || '').trim().toLowerCase());

let retryCount = 0;

let tunnelHttpsAgent = null;

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
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 5) continue;
    const stockId = String(parts[1] || '').trim();
    const text = cleanOneLine(parts[3] || '');
    if (!stockId || !text) continue;
    items.push({ stockId, text });
  }
  return { count: items.length, items };
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

  const topN = Number(process.env.ANNOUNCE_KIMI_TOP_N || 10);
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
    return `### 📌 公告要闻（Kimi精选）\n\n${normalized}\n\n（共${parsed.count}条公告）`;
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

// 发送消息到Server酱的函数
function sendServerChan(message) {
  if (!SERVERCHAN_KEY) {
    console.warn('未设置SERVERCHAN_KEY，跳过Server酱通知');
    return Promise.resolve(false);
  }

  const title = encodeURIComponent('同花顺概念更新成功');
  const desp = encodeURIComponent(message);

  const options = {
    hostname: 'sctapi.ftqq.com',
    path: `/${SERVERCHAN_KEY}.send?title=${title}&desp=${desp}`,
    method: 'GET'
  };

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

    req.end();
  });
}

function runCrawler() {
  const startTime = new Date();
  const attempt = retryCount + 1;
  const logPrefix = `[Attempt ${attempt}/${MAX_RETRIES}]`;
  
  console.log(`${logPrefix} 开始执行爬虫 (${startTime.toLocaleTimeString()})...`);
  
  const child = exec(
    'node runner.js',
    { timeout: EXEC_TIMEOUT },
    (error, stdout, stderr) => {
      const endTime = new Date();
      const elapsed = ((endTime - startTime) / 1000).toFixed(1);
      
      // 记录执行结果
      console.log(`${logPrefix} 执行完成 (耗时: ${elapsed}秒)`);
      console.log(`${logPrefix} stdout >>\n${stdout.trim() || '无输出'}\n<<`);
      if (stderr) console.error(`${logPrefix} stderr >>\n${stderr.trim()}\n<<`);

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
          const kimiDigest = await getAnnouncementDigestByKimi();
          const annSummary = kimiDigest || getAnnouncementSummaryForNotice();
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
          sendServerChan(successMessage).finally(() => process.exit(0));
        })().catch((e) => {
          console.error('Build notice failed:', e && e.message ? e.message : e);
          sendServerChan(`### ✅ 爬虫任务成功执行\n\n但构建通知失败：${e && e.message ? e.message : e}`).finally(() => process.exit(0));
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
        sendServerChan(errorMessage).finally(() => {
          console.error(`[中止] 达到最大重试次数 (${MAX_RETRIES}) 仍未成功`);
          console.error('最后输出:', stdout.trim().slice(-500) || '无输出');
          process.exit(1);
        });
      }
    }
  );

  // 实时输出（可选）
  child.stdout.on('data', data => {
    process.stdout.write(`${logPrefix} STDOUT > ${data}`);
  });
  child.stderr.on('data', data => {
    process.stderr.write(`${logPrefix} STDERR > ${data}`);
  });
}

// 启动
console.log(`== 爬虫监控启动 ==`);
console.log(`配置: ${MAX_RETRIES}次重试/每次间隔${RETRY_INTERVAL/1000}秒`);
runCrawler();
