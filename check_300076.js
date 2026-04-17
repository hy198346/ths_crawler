const https = require('https');

function queryCninfo(pageNum, seDate) {
    const data = new URLSearchParams({
        pageNum: String(pageNum), pageSize: 30,
        column: 'szse', tabName: 'fulltext',
        plate: 'sz', stock: '',
        searchkey: '', secid: '', category: '',
        trade: '', seDate: seDate || '',
        sortName: 'time', sortType: 'desc', isHLtitle: 'true'
    }).toString();
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'www.cninfo.com.cn', path: '/new/hisAnnouncement/query',
            method: 'POST',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Content-Length': Buffer.byteLength(data),
                'X-Requested-With': 'XMLHttpRequest',
                'Referer': 'https://www.cninfo.com.cn/'
            }
        }, (res) => {
            let d = ''; res.on('data', c => d += c); res.on('end', () => {
                try { resolve(JSON.parse(d)); }
                catch { resolve({ error: 'parse failed', body: d.slice(0, 200) }); }
            });
        });
        req.on('error', e => resolve({ error: e.message }));
        req.write(data); req.end();
    });
}

(async () => {
    // Test with today's date and without date filter
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    console.log('Today (Shanghai):', today);

    // Query without seDate (all recent)
    const j1 = await queryCninfo(1, '');
    console.log('\n=== No date filter (page 1) ===');
    console.log('totalpages:', j1.totalpages, 'announcements:', j1.announcements ? j1.announcements.length : 0);
    const has300076 = (j1.announcements || []).filter(a => a.secCode === '300076');
    console.log('300076 hits:', has300076.length);
    if (has300076.length) has300076.forEach(a => console.log(' ', a.announcementTime, (a.announcementTitle||'').slice(0,50)));

    // Show first 3 announcement times to understand the date range
    console.log('\nFirst 5 announcement times:');
    (j1.announcements || []).slice(0, 5).forEach(a => console.log(' ', a.secCode, a.announcementTime, (a.announcementTitle||'').slice(0,30)));

    // Query with today
    const j2 = await queryCninfo(1, today);
    console.log('\n=== With today date filter ===');
    console.log('totalpages:', j2.totalpages, 'announcements:', j2.announcements ? j2.announcements.length : 0);
    const has300076today = (j2.announcements || []).filter(a => a.secCode === '300076');
    console.log('300076 hits today:', has300076today.length);

    // Also check: what stock codes appear in the response
    const codes = [...new Set((j1.announcements || []).map(a => a.secCode))];
    console.log('\nUnique secCodes in response (first 20):', codes.slice(0, 20));
})();