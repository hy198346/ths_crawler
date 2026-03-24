# ths_crawler

## 本地运行

### 1) 配置隧道账号（环境变量）

创建 `.env`（参考 [.env.example](file:///c:/Users/Administrator/Documents/trae_inter/ths_crawler/.env.example)），并在你的终端里加载环境变量：

- `TUNNEL_PROXY`：例如 `x811.kdltps.com:15818`
- `TUNNEL_USERNAME`
- `TUNNEL_PASSWORD`

然后执行：

```bash
npm install
node crawler.js
```

如果你不想用环境变量，也可以创建本地 `crawler-secret.json`（参考 [crawler-secret.example.json](file:///c:/Users/Administrator/Documents/trae_inter/ths_crawler/crawler-secret.example.json)），该文件默认不会被提交。

### 2) 调整并发与重试参数

编辑 [crawler-config.js](file:///c:/Users/Administrator/Documents/trae_inter/ths_crawler/crawler-config.js)：

- `workerCap`：股票详情抓取并发上限
- `sessionPoolSize`：隧道会话池大小（会话复用，避免创建过多连接）
- `listConcurrency`：股票列表页并发
- `retryBaseDelay`/`retryMaxDelay`：重试退避窗口

## GitHub Actions 配置（推荐）

在仓库 Settings → Secrets and variables → Actions → Secrets 新增：

- `TUNNEL_PROXY`
- `TUNNEL_USERNAME`
- `TUNNEL_PASSWORD`
- `SERVERCHAN_KEY`（可选，通知用）

工作流文件为 [.github/workflows/run-script.yml](file:///c:/Users/Administrator/Documents/trae_inter/ths_crawler/.github/workflows/run-script.yml)。
