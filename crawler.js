const http = require("http");
const https = require('https');
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const buffer_helper = require("bufferhelper");
const fs = require("fs");
const path = require("path");

const crawler_config = require('./crawler-config');
const crawler_tools = require('./crawler-tools');
const stock_info_file_path = crawler_config.config.filePath;
const sleep_time = crawler_config.config.sleepTime;
const task_count = crawler_config.config.taksCount;
const task_sleep_count = crawler_config.config.taskSleepCount;
const max_count = crawler_config.config.maxCount;

var stock_info_url = "http://basic.10jqka.com.cn/";
var stock_id_url_params = "fs=m%3A0%2Bt%3A6%2Bf%3A!2%2Cm%3A0%2Bt%3A13%2Bf%3A!2%2Cm%3A0%2Bt%3A80%2Bf%3A!2%2Cm%3A1%2Bt%3A2%2Bf%3A!2%2Cm%3A1%2Bt%3A23%2Bf%3A!2";
var stock_id_list_url = "http://push2.eastmoney.com/api/qt/clist/get?pz=" + max_count +"&pn=1&" + stock_id_url_params + "&fields=f12%2Cf13";

var all_stock_id_list_url = "http://99.push2.eastmoney.com/api/qt/clist/get?pn=1&pz=" + max_count + "&po=1&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12,f13";

var stock_core_view = "";
var stock_main_business = "";
var stock_concept = "";
var stock_sale_limit = "";
var stock_reduce_plan = "";
var stock_investigate = "";

var stock_reduce_cnt = 0;
var stock_sale_limit_cnt = 0;
var stock_investigate_cnt = 0;

const stock_sale_limit_regex = "预计解除限售";
const stock_sale_limit_regex_2 = "限售解禁";
const stock_reduce_regex = "增减持计划";
const stock_investigate_regex = "立案调查";

var task_finised_count = 0;

function get_all_stock_info() {
    if (crawler_config.config.logsFile) {
        crawler_tools.logFileInit();
    }

    console.log('start crawling stock..');
    var start_timestamp = crawler_tools.timestamp();
    
    get_stocks( call_back_arr => {
        
        if (call_back_arr == null || call_back_arr.length == 0)

            return;
        console.log('Total stock count : ' + call_back_arr.length);
        get_all_stock_info_asyn(0, call_back_arr).then(data => {
            create_stock_info_file();
            let end_timestamp = crawler_tools.timestamp();
            let used_time = end_timestamp - start_timestamp;
            console.log('Total stock info count : ' + call_back_arr.length);
            console.log('Total time used : ' + (used_time / 1000) + ' s');
        });
    });
}

async function get_all_stock_info_asyn(start_index, stock_id_arr) {
    if (sleep_time > 0 && (task_finised_count % task_sleep_count) == 0 && task_finised_count > 0) { 
        await sleep(sleep_time); 
    }
    return new Promise(function(resolve, reject) {
        let count = 0;
        let total_stock_count = stock_id_arr.length;
        let tasks = [];
        for (var i = start_index; i < total_stock_count && count < task_count; i++, count++) {
            let stock_id = stock_id_arr[i]['f12'];
            let stock_exchange_id = stock_id_arr[i]['f13'];
            if (stock_id.startsWith("8") || stock_id.startsWith("4")) {
                stock_exchange_id = "2";
            }
            let promise_task = get_stock_info(stock_id, stock_exchange_id);
            tasks.push(promise_task);
        }
        Promise.all(tasks).then(data => { 
            if (task_finised_count >= total_stock_count) {
                resolve();
            } else {
                task_finised_count += task_count;
                let precent = ((task_finised_count / total_stock_count) * 100);
                if (precent > 100) precent = 100;
                console.log('finished crawled : ' + precent.toFixed(2) + '%');
                get_all_stock_info_asyn(task_finised_count, stock_id_arr).then(data => { resolve(); });
            }
        }); 
    });
}

const sleep = function(ms) {
    console.log('wait ' + (ms / 1000) + ' second(s) to prevent website block');
    return new Promise(resolve => setTimeout(resolve, ms))
}

// Get all ths stocks' id
// Return the stock id array
async function get_stocks(call_back) {
    let all_stock_ids = [];
    var page = 1;
    let result = await get_stocks_by_page(page);
    var total_page = parseInt(result.total / 100);
    if (result.total % 100 != 0) {
        total_page++;
    }
    all_stock_ids.push(...result.arr);

    while(page < total_page) {
        page++;
        let result = await get_stocks_by_page(page);
        all_stock_ids.push(...result.arr);
    }
    call_back(all_stock_ids);
};

function get_stocks_by_page(page) {
    //console.log(`[Page ${page}] Starting stock data fetch...`);
    
    return new Promise((resolve, reject) => {
        // 使用最新推荐的主机名
        const host = "push2delay.eastmoney.com";
        const path = `/api/qt/clist/get?pn=${page}&pz=100&po=1&fid=f3&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048&fields=f12,f13`;
        
        //console.log(`[Page ${page}] Requesting: ${host}${path}`);
        
        // 配置请求选项
        const options = {
            hostname: host,
            path: path,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'application/json',
                'Referer': 'https://quote.eastmoney.com/',
                'Connection': 'keep-alive'
            },
            timeout: 10000 // 10秒超时
        };
        
        // 选择协议处理器
        const protocolHandler = options.port === 443 ? https : http;
        //console.log(`[Page ${page}] Using ${protocolHandler === https ? 'HTTPS' : 'HTTP'} protocol`);
        
        const req = protocolHandler.get(options, (res) => {
            //console.log(`[Page ${page}] HTTP response received. Status: ${res.statusCode} ${res.statusMessage}`);
            
            // 处理重定向
            if ([301, 302, 307, 308].includes(res.statusCode)) {
                const redirectUrl = res.headers.location;
                console.log(`[Page ${page}] Redirecting to: ${redirectUrl}`);
                return resolve(get_stocks_by_page(page)); // 递归跟随重定向
            }
            
            // 验证状态码
            if (res.statusCode !== 200) {
                const err = new Error(`Invalid status code: ${res.statusCode}`);
                console.error(`[Page ${page}] ${err.message}`);
                return reject(err);
            }
            
            let rawData = [];
            let totalBytes = 0;
            
            res.on('data', (chunk) => {
                rawData.push(chunk);
                totalBytes += chunk.length;
                //console.log(`[Page ${page}] Received chunk ${chunk.length} bytes`);
            });
            
            res.on('end', () => {
                try {
                    //console.log(`[Page ${page}] Transfer complete. Total bytes: ${totalBytes}`);
                    
                    // 检查空响应
                    if (totalBytes === 0) {
                        throw new Error('Empty API response');
                    }
                    
                    const buffer = Buffer.concat(rawData, totalBytes);
                    //console.log(`[Page ${page}] Buffer created (${buffer.length} bytes)`);
                    
                    const dataJson = JSON.parse(buffer.toString());
                    //console.log(`[Page ${page}] JSON parsed successfully`);
                    
                    // 验证响应结构
                    if (!dataJson.data?.diff) {
                        console.warn(`[Page ${page}] Unexpected API structure:`, JSON.stringify(dataJson, null, 2).substring(0, 300));
                        throw new Error('Invalid API response structure');
                    }
                    
                    const stocks = Object.values(dataJson.data.diff);
                    const totalCount = dataJson.data.total || 0;
                    
                    //console.log(`[Page ${page}] Processed ${stocks.length} stock records`);
                    resolve({
                        arr: stocks,
                        total: totalCount
                    });
                    
                } catch (e) {
                    console.error(`[Page ${page}] Processing error: ${e.message}`);
                    console.error(`[Page ${page}] Stack trace: ${e.stack}`);
                    reject(e);
                }
            });
        });
        
        // 错误处理
        req.on('error', (err) => {
            console.error(`[Page ${page}] Network error: ${err.message}`);
            reject(err);
        });
        
        req.on('timeout', () => {
            console.error(`[Page ${page}] Request timeout`);
            req.destroy(); // 中断请求
            reject(new Error('Request timeout'));
        });
        
        //console.log(`[Page ${page}] Request initiated`);
    });
}

// Create the extern_user.txt
function create_stock_info_file() {
    // backup old file
    let backup_file_path = get_backup_file_path();
    fs.rename(stock_info_file_path, backup_file_path, (err) => {
        if (err && err.code == 'ENOENT') {
            // file is not exsits
        }
    });

    let file_content = stock_main_business + stock_core_view + stock_concept + stock_sale_limit + stock_reduce_plan + stock_investigate;
    let file_content_gbk = iconv.encode(file_content, 'GBK');
    fs.writeFile(stock_info_file_path, file_content_gbk, function(err) {
        if (err) { 
            console.log(err.message);
            return false; 
        }
        console.log('create ' + stock_info_file_path + ' successed.');
    });
};

// Get the stock basic info
// Then put the info into the string
// stock_exchange_id value : 0 - SZ, 1 - SH
function get_stock_info(stock_id, stock_exchange_id) {

    return new Promise(function(resolve, reject) {
        let url = stock_info_url + stock_id + "/";
        http.get(url, (res) => {
            let raw_data = new buffer_helper();
            
            res.on('data', (chunk) => { raw_data.concat(chunk); });
            res.on('end', () => {
                try {
                    let doc_data = iconv.decode(raw_data.toBuffer(), 'GBK');
                    let doc = cheerio.load(doc_data);
                    let stock_info_prex = stock_exchange_id + '|' + stock_id;
                    let core_view = doc('span.core-view-text').text();
                    let main_business = doc('span.main-bussiness-text').find('a.newtaid').text();
                    let concepts = '';


                    let sale_limit_div = doc('div.new_msg').find('div.overview');
                    let sale_limit_detail = "";
                    sale_limit_div.find('table tr').each((index, element) => {
                        if (index >= 20) return false; // read 20 lines at max
                        let sale_limit_title = crawler_tools.str_trim(doc(element).find('td strong.hltip').text());

                        
                        if (sale_limit_title && (sale_limit_title.indexOf(stock_sale_limit_regex) != -1 || sale_limit_title.indexOf(stock_sale_limit_regex_2) != -1 )) {
                            let sale_limit_date = crawler_tools.str_trim(doc(element).find('td:first-child').text());
                            let sale_limit_text = crawler_tools.str_trim(doc(element).find('td a:first-child').text());
                            if(sale_limit_date.length > 10) sale_limit_date = "今天";
                            let sale_limit_detail = sale_limit_date + " " + sale_limit_text;
                            stock_sale_limit += stock_info_prex + '|19|' + sale_limit_detail + '|0.000\n';
                            
                            stock_sale_limit_cnt += 1;
                            
                            return false;
                        } else if (sale_limit_title && sale_limit_title.indexOf(stock_reduce_regex) != -1) {
                            let stock_reduce_text = crawler_tools.str_trim(doc(element).find('td span').text());
                            stock_reduce_plan += stock_info_prex + '|20|' + stock_reduce_text + '|0.000\n';
                            
                            //console.log(stock_reduce_plan);
                            stock_reduce_cnt +=1;
                            return false;
                        } else if (sale_limit_title && sale_limit_title.indexOf(stock_investigate_regex) != -1) {
                            let stock_investigate_text = crawler_tools.str_trim(doc(element).find('td span').text());
                            stock_investigate_text = stock_investigate_text.replace(/[r\n]/g,"");
                            stock_investigate_text = stock_investigate_text.replace(/\ +/g,"");
                            //let index = stock_investigate_text.indexOf(/\u25bc/);
                            let index = stock_investigate_text.indexOf('▼');
                            //console.log(index);
                            stock_investigate_text = stock_investigate_text.substr(0, index);
                            index = stock_investigate_text.indexOf('详细内容');
                            stock_investigate_text = stock_investigate_text.substr(0, index);
                            stock_investigate += stock_info_prex + '|21|' + stock_investigate_text + '|0.000\n';
                            
                            //console.log(stock_investigate);
                            stock_investigate_cnt += 1;
                            return false;
                        }
                    });

                    /*let concept_dash_ele = doc('div.newconcept').find('a[href].alltext');
                    if (concept_dash_ele != null && crawler_tools.str_trim(concept_dash_ele.text()).length != 0) {
                        // get concept detail from concept detail page
                        get_concept_detail(stock_id).then(data => { 
                            stock_core_view += stock_info_prex + '|9|' + crawler_tools.str_trim(core_view) + '|0.000\n';
                            stock_main_business += stock_info_prex + '|8|' + crawler_tools.str_trim(main_business) + '|0.000\n';
                            stock_concept += stock_info_prex + '|18|' + data + '|0.000\n';
                            //console.log('test: ' + stock_concept);
                            resolve();
                        });
                    } else {*/
                        doc('div.newconcept').find('a.newtaid').not('a.alltext').each((index, element) => {
                            if (index > 0) concepts += ',';
                            let concept_text = doc(element).text();
                            concepts += crawler_tools.str_trim(concept_text);
                        });

                        stock_core_view += stock_info_prex + '|9|' + crawler_tools.str_trim(core_view) + '|0.000\n';
                        stock_main_business += stock_info_prex + '|8|' + crawler_tools.str_trim(main_business) + '|0.000\n';
                        stock_concept += stock_info_prex + '|18|' + concepts + '|0.000\n';
                        //console.log('test: ' + stock_concept);
                        resolve();
                    //}
                    
                } catch (e) {
                    console.error('Parse the html error : ' + e.message);
                }
            });
        }).on('error', (err) => {
            console.log(err.message);
        });
    });
};

function get_concept_detail(stock_id) {
    return new Promise(function(resolve, reject) {
        let url = stock_info_url + stock_id + "/concept.html#ifind";
        let concepts = '';
        http.get(url, (res) => {
            let raw_data = new buffer_helper();
            res.on('data', (chunk) => { raw_data.concat(chunk); });
            res.on('end', () => {
                try {
                    let doc_data = iconv.decode(raw_data.toBuffer(), 'GBK');
                    let doc = cheerio.load(doc_data);
                    doc('table.gnContent tbody tr').not('tr.extend_content').each((index, element) => {
                        let concept_text = doc(element).find('td.gnName').text();
                        concept_text = crawler_tools.str_trim(concept_text);
                        if (concept_text && concept_text.length > 0) {
                            if (index > 0) concepts += ',';
                            concepts += concept_text;
                        }
                    });
                    resolve(concepts);
                } catch (e) {
                    console.error('Parse the html error : ' + e.message);
                }
            });
        }).on('error', (err) => {
            console.log(err.message);
        });
    });
}

function get_backup_file_path() {
    let extname = path.extname(stock_info_file_path);
    let prex_path = stock_info_file_path.substring(0, stock_info_file_path.indexOf(extname));
    let backup_file_path = prex_path + '_' + crawler_tools.timestamp() + extname;
    
    console.log('减持家数：' + stock_reduce_cnt);
    console.log('解禁家数：' + stock_sale_limit_cnt);
    console.log('立案家数：' + stock_investigate_cnt);
    
    return backup_file_path;
}

get_all_stock_info();

//get_stock_info("000977", 0);
//get_stock_info("300414", 0);
//get_stock_info("601718", 1);
