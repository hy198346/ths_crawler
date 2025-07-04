const { exec } = require('child_process');

// 配置参数
const MAX_RETRIES = 10;         // 最大重试次数
const RETRY_INTERVAL = 30000;   // 重试间隔(毫秒)
const EXEC_TIMEOUT = 600000;   // 执行超时时间(10分钟)
const SUCCESS_FLAG = 'successed'; // 成功标识

let retryCount = 0;

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
        console.error(`[中止] 达到最大重试次数 (${MAX_RETRIES}) 仍未成功`);
        console.error('最后输出:', stdout.trim().slice(-500) || '无输出');  // 截取末尾500字符
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
