const { fetchData, fetchHtml, _tunnelProxyState } = require('./crawler');

async function run() {
    console.log('Tunnel enabled:', _tunnelProxyState.isEnabled());
    console.log('Tunnel failures:', _tunnelProxyState.getFailureCount());

    const host = "push2delay.eastmoney.com";
    const path = `/api/qt/clist/get?pn=1&pz=1&po=1&fid=f3&fs=m:0+t:6&fields=f12,f13`;
    const options = {
        hostname: host,
        path: path,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/json',
            'Referer': 'https://quote.eastmoney.com/'
        },
        timeout: 15000
    };

    try {
        const data = await fetchData(options);
        const total = data?.data?.total;
        const first = data?.data?.diff && Object.values(data.data.diff)[0];
        console.log('Eastmoney ok:', typeof total === 'number');
        console.log('First stock:', first?.f12, first?.f13);
    } catch (e) {
        console.error('Eastmoney error:', e.message);
    }

    try {
        const html = await fetchHtml('http://basic.10jqka.com.cn/000001/');
        console.log('10jqka ok:', typeof html === 'string' && html.length > 0);
        console.log('HTML length:', html.length);
    } catch (e) {
        console.error('10jqka error:', e.message);
    }

    console.log('Tunnel enabled:', _tunnelProxyState.isEnabled());
    console.log('Tunnel failures:', _tunnelProxyState.getFailureCount());
}

run().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
