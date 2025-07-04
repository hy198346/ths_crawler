const { exec } = require('child_process');

// 配置参数
const MAX_RETRIES = 10;         // 最大重试次数
const RETRY_INTERVAL = 30000;   // 重试间隔(毫秒)
const SUCCESS_FLAG = 'successed'; // 成功标识

let retryCount = 0;

function runCrawler() {
  exec('node crawler.js', (error, stdout, stderr) => {
    // 统一记录日志
    const logPrefix = `[Attempt ${retryCount + 1}/${MAX_RETRIES}]`;
    
    if (error) {
      console.error(`${logPrefix} 执行错误:`, error.message);
      if (stderr) console.error(`${logPrefix} 错误输出:`, stderr.trim());
    }

    // 关键：优先检查成功标志
    if (stdout.includes(SUCCESS_FLAG)) {
      console.log(`${logPrefix} 爬取成功！`);
      console.log('最终输出:', stdout.trim());
      return; // 成功时直接退出
    }

    // 未达到最大重试次数时继续
    if (retryCount < MAX_RETRIES - 1) {
      retryCount++;
      console.log(`${logPrefix} 未检测到成功标志，${RETRY_INTERVAL/1000}秒后重试...`);
      console.log('当前输出:', stdout.trim());
      if (stderr) console.error('错误输出:', stderr.trim());
      
      setTimeout(runCrawler, RETRY_INTERVAL);
    } else {
      console.error(`[中止] 达到最大重试次数 (${MAX_RETRIES}) 仍未成功`);
      process.exit(1); // 退出进程并返回错误码
    }
  });
}

runCrawler();
