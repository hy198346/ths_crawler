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
    taksCount : 200,
    taskSleepCount : 4000,
    logsFile : false,
    maxCount : 8000
}

exports.config = crawler_config;
