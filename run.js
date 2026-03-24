const { exec } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// 配置参数
const MAX_RETRIES = 5;         // 最大重试次数
const RETRY_INTERVAL = 120000;   // 重试间隔(毫秒)
const EXEC_TIMEOUT = 1800000;   // 执行超时时间(30分钟)
const SUCCESS_FLAG = 'created'; // 成功标识
const SERVERCHAN_KEY = process.env.SERVERCHAN_KEY; // 从环境变量获取Server酱密钥

let retryCount = 0;

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

// 发送消息到Server酱的函数
function sendServerChan(message) {
  if (!SERVERCHAN_KEY) {
    console.warn('未设置SERVERCHAN_KEY，跳过Server酱通知');
    return;
  }

  const title = encodeURIComponent('同花顺概念更新成功');
  const desp = encodeURIComponent(message);

  const options = {
    hostname: 'sctapi.ftqq.com',
    path: `/${SERVERCHAN_KEY}.send?title=${title}&desp=${desp}`,
    method: 'GET'
  };

  const req = https.request(options, (res) => {
    let responseBody = '';
    res.on('data', (chunk) => responseBody += chunk);
    res.on('end', () => {
      console.log('Server酱通知状态:', res.statusCode);
      try {
        const result = JSON.parse(responseBody);
        if (result.code === 0) {
          console.log('✅ Server酱通知发送成功');
        } else {
          console.error('❌ Server酱发送失败:', result.message);
        }
      } catch (e) {
        console.error('Server酱响应解析失败:', e.message);
      }
    });
  });

  req.on('error', (error) => {
    console.error('Server酱请求失败:', error.message);
  });

  req.end();
}

function runCrawler() {
  const startTime = new Date();
  const attempt = retryCount + 1;
  const logPrefix = `[Attempt ${attempt}/${MAX_RETRIES}]`;
  
  console.log(`${logPrefix} 开始执行爬虫 (${startTime.toLocaleTimeString()})...`);
  
  const child = exec(
    'node crawler.js',
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
        
        // 发送Server酱通知
        const externUserSize = getExternUserFileSizeForNotice();
        const successMessage = [
          `### ✅ 爬虫任务成功执行`,
          `**尝试次数**: ${attempt}/${MAX_RETRIES}`,
          `**开始时间**: ${startTime.toLocaleString()}`,
          `**结束时间**: ${endTime.toLocaleString()}`,
          `**执行耗时**: ${elapsed}秒`,
          `**extern_user.txt 大小**: ${externUserSize}`,
          `**输出摘要**: ${stdout.trim().slice(-100)}`
        ].join('\n\n');
        
        sendServerChan(successMessage);
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
        const errorMessage = [
          `## ❌ 爬虫任务失败`,
          `已达最大重试次数 (${MAX_RETRIES})`,
          `**extern_user.txt 大小**: ${externUserSize}`
        ].join('\n\n');
        sendServerChan(errorMessage);
        
        console.error(`[中止] 达到最大重试次数 (${MAX_RETRIES}) 仍未成功`);
        console.error('最后输出:', stdout.trim().slice(-500) || '无输出');
        process.exit(1);
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
