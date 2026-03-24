/**
 * 
 * 配置文件
 * 
 * filePath -- 最后生成的extern_user.txt的存放路径
 * sleepTime -- 休眠时间
 * taskCount -- 同时开启线程数量
 * taskSleepCount -- 爬取 taskSleepCount 数量后进入休眠
 * logsFile -- 是否生成日志文件
 * maxCount - 最多爬取数量 
 *
 * 例如默认配置中，10个线程共爬取50个后休眠5000毫秒,最多爬取8000个
 * 
 */
const crawler_config = {
    filePath : './extern_user.txt',
    sleepTime : 000,
    taksCount : 400,
    taskSleepCount : 4000,
    logsFile : false,
    maxCount : 8000,
    onlyStockList : false,
    maxStocks : 0,
    workerCap : 400,
    listConcurrency : 8,
    fetchTimeout : 12000,
    ciMainTimeout : 12000,
    ciRecoveryTimeout : 20000,
    ciDirectFallback : true,
    ciMainMaxRetries : 2,
    ciDirectFallbackMs : 30000,
    tunnelOnBlockedMs : 60000,
    retryBaseDelay : 200,
    retryMaxDelay : 2500,
    sessionPoolSize : 20,
    stockMaxRetries : 3,
    recoveryRounds : 2,
    recoveryWorkerCap : 40,
    recoveryMaxRetries : 6,
    adaptiveConcurrency : true,
    adaptiveMinWorkers : 40,
    adaptiveWindowSize : 200,
    adaptiveHangupHigh : 0.12,
    adaptiveHangupLow : 0.03,
    adaptiveAdjustCooldownMs : 15000
}

exports.config = crawler_config;
