/**
 * T4.1 spike — browser driver (THROWAWAY). Drives the measurement in
 * real, headed Chrome and Firefox at 1280×800 and 1920×1080:
 *
 *   NODE_PATH=<dir with puppeteer-core> node run.cjs <export-dir> <out-dir>
 *
 * Chrome runs over CDP; stock Firefox runs over WebDriver BiDi — both
 * system binaries, no downloaded browser builds. Sort presses go
 * through page.mouse (trusted input) relayed into the page harness;
 * the harness does the measuring; this script launches, screenshots at
 * the phases the harness publishes, and writes JSON per run.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const exportDir = process.argv[2];
const outDir = process.argv[3];
const PORT = 8091;

const CHROME = '/usr/bin/chromium';
const FIREFOX = '/usr/bin/firefox';
const URL_PATH = '/spike/rnw-desktop';
const SIZES = [
  { name: '1280', width: 1280, height: 800 },
  { name: '1920', width: 1920, height: 1080 },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

function createStaticServer(root, port) {
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end();
      return;
    }
    if (urlPath === '/' || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(root, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function runOne(browserName, size) {
  const launchOpts =
    browserName === 'chromium'
      ? {
          executablePath: CHROME,
          headless: false,
          defaultViewport: { width: size.width, height: size.height },
          args: ['--disable-dev-shm-usage', '--no-first-run', '--disable-session-crashed-bubble'],
        }
      : {
          browser: 'firefox',
          executablePath: FIREFOX,
          headless: false,
          defaultViewport: { width: size.width, height: size.height },
          args: ['-no-remote', '-profile', `/tmp/rnw-measure/ff-profile-${size.name}`],
        };

  const browser = await puppeteer.launch(launchOpts);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(120_000);
    await page.exposeFunction('__nativeClick', async (x, y) => {
      await page.mouse.click(x, y);
    });
    await page.goto(`http://127.0.0.1:${PORT}${URL_PATH}`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction('window.__rnwspike && window.__rnwspike.ready === true', { timeout: 90_000 });
    await new Promise((r) => setTimeout(r, 1500)); // fonts settle, first layout done

    const tag = `${browserName}-${size.name}`;
    await page.screenshot({ path: path.join(outDir, `${tag}-top.png`) });

    await page.addScriptTag({ path: path.join(__dirname, 'page-harness.js') });

    // The harness publishes phases; screenshot the scrolled-bottom
    // state while it holds still there.
    await page.waitForFunction('window.__rnwPhase === "at-bottom"', { timeout: 120_000 });
    await page.screenshot({ path: path.join(outDir, `${tag}-bottom.png`) });

    const results = await page.evaluate(() => window.__rnwMeasureDone);

    const jsonPath = path.join(outDir, `${tag}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
    console.log(`[${tag}] wrote ${jsonPath}`);
    return results;
  } finally {
    await browser.close();
  }
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const server = createStaticServer(exportDir, PORT);
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  console.log(`static server on :${PORT}`);

  const all = {};
  try {
    for (const browserName of ['chromium', 'firefox']) {
      for (const size of SIZES) {
        const tag = `${browserName}-${size.name}`;
        try {
          all[tag] = await runOne(browserName, size);
        } catch (err) {
          console.error(`[${tag}] FAILED:`, err.message);
          all[tag] = { error: err.message };
        }
      }
    }
  } finally {
    server.close();
  }
  fs.writeFileSync(path.join(outDir, 'all-runs.json'), JSON.stringify(all, null, 2));
  console.log('done');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
