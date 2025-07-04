const { exec } = require('child_process');

function runCrawler() {
  exec('node crawler.js', (error, stdout, stderr) => {
    if (stdout.includes('successed')) {
      console.log('Crawler succeeded!');
      return;

    } else {
      console.log('Crawler output:', stdout);
      setTimeout(runCrawler, 30000);
    }
  });
}

runCrawler();
