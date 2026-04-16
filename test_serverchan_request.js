const { buildServerChanRequest } = require('./run');

function assertTrue(name, ok) {
  if (!ok) throw new Error(`${name} failed`);
}

function run() {
  const key = 'TESTKEY';
  const msg = `line1\n${'x'.repeat(5000)}\nline3`;
  const { options, body } = buildServerChanRequest(msg, key);

  assertTrue('method is POST', options && options.method === 'POST');
  assertTrue('path has .send', typeof options.path === 'string' && options.path === `/${key}.send`);
  assertTrue('not query', typeof options.path === 'string' && !options.path.includes('?'));
  assertTrue('body has title', body.includes('title='));
  assertTrue('body has desp', body.includes('desp='));
  assertTrue('content-length matches', Number(options.headers['Content-Length']) === Buffer.byteLength(body));

  console.log('OK');
}

run();
