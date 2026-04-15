const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const ROOT = __dirname;
const THS_TMP_PATH = process.env.THS_TMP_PATH || path.join(ROOT, 'extern_user_ths.txt');
const ANN_TMP_PATH = process.env.ANN_TMP_PATH || path.join(ROOT, 'extern_user_ann.txt');
const OUT_PATH = process.env.OUT_PATH || path.join(ROOT, 'extern_user.txt');

function runNode(script, envOverrides = {}) {
    return new Promise((resolve) => {
        const child = execFile(
            process.execPath,
            [path.join(ROOT, script)],
            {
                env: { ...process.env, ...envOverrides },
                windowsHide: true,
                maxBuffer: 64 * 1024 * 1024
            },
            (error, stdout, stderr) => {
                resolve({
                    ok: !error,
                    code: error && typeof error.code === 'number' ? error.code : 0,
                    stdout: String(stdout || ''),
                    stderr: String(stderr || '')
                });
            }
        );
        child.on('error', (e) => {
            resolve({ ok: false, code: 1, stdout: '', stderr: String(e && e.message ? e.message : e) });
        });
    });
}

function backupPath(p) {
    const ext = path.extname(p);
    const base = p.slice(0, -ext.length);
    return `${base}_${Date.now()}${ext}`;
}

function countLf(buf) {
    let n = 0;
    for (const b of buf) {
        if (b === 10) n += 1;
    }
    return n;
}

function stripCreatedLines(text) {
    const lines = String(text || '').split(/\r?\n/);
    const kept = [];
    for (const line of lines) {
        if (!line) continue;
        if (line.startsWith('File created:')) continue;
        if (line.startsWith('Line count:')) continue;
        kept.push(line);
    }
    return kept.length ? kept.join('\n') + '\n' : '';
}

async function main() {
    const thsPromise = runNode('crawler.js', {
        STOCK_INFO_FILE_PATH: THS_TMP_PATH,
        ENABLE_ANNOUNCEMENTS: 'false'
    });

    const annPromise = runNode('announcement_fetcher.js', {
        ANN_OUTPUT_PATH: ANN_TMP_PATH
    });

    const [ths, ann] = await Promise.all([thsPromise, annPromise]);

    if (ths.stdout) process.stdout.write(stripCreatedLines(ths.stdout));
    if (ths.stderr) process.stderr.write(ths.stderr);

    if (!ann.ok) {
        if (ann.stdout) process.stdout.write(ann.stdout);
        if (ann.stderr) process.stderr.write(ann.stderr);
        console.warn('公告抓取失败，继续生成同花顺结果');
    } else {
        if (ann.stdout) process.stdout.write(ann.stdout);
        if (ann.stderr) process.stderr.write(ann.stderr);
    }

    if (!ths.ok) {
        process.exit(1);
        return;
    }

    if (!fs.existsSync(THS_TMP_PATH)) {
        console.error('同花顺临时文件不存在');
        process.exit(1);
        return;
    }

    const thsBuf = fs.readFileSync(THS_TMP_PATH);
    const thsText = iconv.decode(thsBuf, 'GBK');

    let annText = '';
    if (fs.existsSync(ANN_TMP_PATH) && ann.ok) {
        annText = fs.readFileSync(ANN_TMP_PATH, 'utf8');
    }

    const combined = `${thsText}${annText}`;
    const outBuf = iconv.encode(combined, 'GBK');

    try {
        if (fs.existsSync(OUT_PATH)) {
            fs.renameSync(OUT_PATH, backupPath(OUT_PATH));
        }
    } catch (e) {
        console.error('Backup error:', e && e.message ? e.message : e);
    }

    fs.writeFileSync(OUT_PATH, outBuf);
    console.log(`File created: ${path.basename(OUT_PATH) === 'extern_user.txt' ? './extern_user.txt' : OUT_PATH}`);
    console.log(`Line count: ${countLf(outBuf)}`);
}

main().catch((e) => {
    console.error(e && e.stack ? e.stack : String(e));
    process.exit(1);
});

