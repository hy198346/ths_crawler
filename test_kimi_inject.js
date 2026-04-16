const fs = require('fs');
const path = require('path');

const { loadStockNameMap, injectStockNamesIntoKimiSection } = require('./run');

function assertEqual(name, a, b) {
  if (a !== b) {
    throw new Error([`${name} failed`, '--- expected ---', b, '--- actual ---', a].join('\n'));
  }
}

function run() {
  const tmpStockListPath = path.resolve(__dirname, 'tmp_stock_list_for_test.json');
  fs.writeFileSync(tmpStockListPath, JSON.stringify({ stocks: [{ f12: '600000', f14: '浦发银行' }] }, null, 2), 'utf8');

  const prev = process.env.STOCK_LIST_PATH;
  process.env.STOCK_LIST_PATH = tmpStockListPath;
  const map = loadStockNameMap();

  const input = [
    '### ✅ 爬虫任务成功执行',
    '',
    '### 📌 公告要闻（Kimi精选）',
    '',
    '- 600000 2025年度拟10派2元',
    '- 000001 一季度业绩预告大增',
    '',
    '（共2条公告）',
    '',
    '### 其他段落',
    '',
    '- 600000 不应被改动（不在Kimi段落）'
  ].join('\n');

  const expected = [
    '### ✅ 爬虫任务成功执行',
    '',
    '### 📌 公告要闻（Kimi精选）',
    '',
    '- 600000 浦发银行 2025年度拟10派2元',
    '- 000001 一季度业绩预告大增',
    '',
    '（共2条公告）',
    '',
    '### 其他段落',
    '',
    '- 600000 不应被改动（不在Kimi段落）'
  ].join('\n');

  const output = injectStockNamesIntoKimiSection(input, map);
  assertEqual('injectStockNamesIntoKimiSection', output, expected);

  if (typeof prev === 'undefined') delete process.env.STOCK_LIST_PATH;
  else process.env.STOCK_LIST_PATH = prev;
  try { fs.unlinkSync(tmpStockListPath); } catch {}

  console.log('OK');
}

run();
