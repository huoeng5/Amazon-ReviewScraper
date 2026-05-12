import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  addJobs,
  clearQueueJobs,
  closeJobStore,
  getNextPendingJob,
  JOB_STATUSES,
  markJobCompleted,
  markJobDeleted,
  markJobFailed,
  markJobRunning,
  markJobStopped,
  openJobStore,
  recoverRunningJobs,
  requeueFailedJobs,
  requeueJob,
  resetAllData,
  seedJobsFromProducts,
} from '../src/job-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const UI_DIST = path.join(ROOT_DIR, 'ui', 'dist', 'index.html');
const APP_DISPLAY_NAME = 'Amazon ReviewScraper';

app.setName(APP_DISPLAY_NAME);

const NODE_BIN = app.isPackaged ? process.execPath : process.env.npm_node_execpath || process.env.NODE || 'node';
const APP_DATA_DIR = app.getPath('userData');
const DEFAULT_DB_PATH = app.isPackaged
  ? path.join(APP_DATA_DIR, 'iceman.sqlite')
  : path.join(ROOT_DIR, 'data', 'iceman.sqlite');
const DEFAULT_PROFILE_DIR = app.isPackaged
  ? path.join(APP_DATA_DIR, 'browser-profiles', 'amazon-jp')
  : path.join(ROOT_DIR, '.browser-profiles', 'amazon-jp');
const DEFAULT_OUTPUT_DIR = app.isPackaged ? path.join(APP_DATA_DIR, 'output') : path.join(ROOT_DIR, 'output');
const DEFAULT_SNAPSHOT_ROOT = app.isPackaged
  ? path.join(APP_DATA_DIR, 'snapshots')
  : path.join(ROOT_DIR, 'snapshots');
const PACKAGED_PLAYWRIGHT_BROWSERS = path.join(process.resourcesPath, 'ms-playwright');

let mainWindow = null;
let activeCrawl = null;
let queuePaused = false;
let stoppingJobId = null;
let dataLoadQueue = Promise.resolve();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    title: APP_DISPLAY_NAME,
    backgroundColor: '#f8f9fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(UI_DIST);
  }
}

function send(channel, payload) {
  mainWindow?.webContents.send(channel, payload);
}

function sendJobsChanged(payload = {}) {
  send('jobs:changed', {
    paused: queuePaused,
    running: Boolean(activeCrawl),
    ...payload,
  });
}

function nowTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function parseAsin(input) {
  const text = String(input ?? '').trim();
  if (/^[A-Z0-9]{10}$/i.test(text)) return text.toUpperCase();

  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/product-reviews\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /[?&]asin=([A-Z0-9]{10})(?:&|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }

  return '';
}

function normalizeProductId(input) {
  const text = String(input ?? '').trim();
  if (!text) return '';
  return parseAsin(text) || text;
}

function safeFilePart(input) {
  return String(input || 'reviews')
    .trim()
    .replaceAll(/[^a-z0-9_-]+/gi, '_')
    .replaceAll(/^_+|_+$/g, '')
    .slice(0, 120) || 'reviews';
}

function parseJsonFromStdout(stdout) {
  const text = stdout.trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      return JSON.parse(text.slice(first, last + 1));
    }
    throw new Error(`Cannot parse JSON output: ${text.slice(0, 240)}`);
  }
}

function childEnv() {
  const env = { ...process.env };
  if (app.isPackaged) {
    env.ELECTRON_RUN_AS_NODE = '1';
    env.PLAYWRIGHT_BROWSERS_PATH = PACKAGED_PLAYWRIGHT_BROWSERS;
  }
  return env;
}

function runNodeJson(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [scriptPath, ...args], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(),
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Node process exited with code ${code}`));
        return;
      }

      try {
        resolve(parseJsonFromStdout(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function splitLines(buffer, chunkText, onLine) {
  const next = `${buffer}${chunkText}`;
  const lines = next.split(/\r?\n/);
  const rest = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim()) onLine(line);
  }
  return rest;
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

function writeRowsCsv(filePath, rows) {
  const headers = [
    'platform',
    'product_id',
    'product_title',
    'review_id',
    'review_url',
    'rating',
    'rating_text',
    'review_title',
    'review_body',
    'reviewer_name',
    'review_date',
    'variant',
    'verified_purchase',
    'helpful_count',
    'scraped_at',
  ];
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ];
  fs.writeFileSync(filePath, `\uFEFF${lines.join('\n')}\n`, 'utf8');
}

function sqliteTableExists(db, tableName) {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName),
  );
}

function loadReviewRows({ productId = '' } = {}) {
  const db = new DatabaseSync(DEFAULT_DB_PATH);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    if (!sqliteTableExists(db, 'reviews')) return [];
    const hasProductsTable = sqliteTableExists(db, 'products');
    const productTitleSelect = hasProductsTable ? "COALESCE(p.product_title, '')" : "''";
    const productJoin = hasProductsTable
      ? 'LEFT JOIN products p ON p.platform = r.platform AND p.product_id = r.product_id'
      : '';
    const where = productId ? 'WHERE r.product_id = ?' : '';
    const params = productId ? [productId] : [];

    return db.prepare(`
      SELECT
        r.platform,
        r.product_id,
        ${productTitleSelect} AS product_title,
        r.review_id,
        r.review_url,
        r.rating,
        r.rating_text,
        r.review_title,
        r.review_body,
        r.reviewer_name,
        r.review_date,
        r.variant,
        r.verified_purchase,
        r.helpful_count,
        r.scraped_at
      FROM reviews r
      ${productJoin}
      ${where}
      ORDER BY r.product_id, COALESCE(r.review_date, '') DESC, r.review_id
    `).all(...params);
  } finally {
    db.close();
  }
}

function withJobDb(callback) {
  const db = openJobStore(DEFAULT_DB_PATH);
  try {
    return callback(db);
  } finally {
    closeJobStore(db);
  }
}

function buildCrawlArgs(job) {
  const useUrl = String(job.input || '').trim().startsWith('http');
  if (job.platform === 'rakuten') {
    const args = [
      path.join(ROOT_DIR, 'src', 'rakuten-poc.js'),
      useUrl ? '--url' : '--item',
      useUrl ? job.input : job.product_id,
      '--max-pages',
      String(job.max_pages || 20),
      '--db',
      DEFAULT_DB_PATH,
      '--output-dir',
      DEFAULT_OUTPUT_DIR,
      '--snapshot-dir',
      path.join(DEFAULT_SNAPSHOT_ROOT, 'rakuten'),
    ];

    if (job.incremental) args.push('--incremental');
    return args;
  }

  if (job.platform === 'yahoo_shopping') {
    const args = [
      path.join(ROOT_DIR, 'src', 'yahoo-poc.js'),
      useUrl ? '--url' : '--item',
      useUrl ? job.input : job.product_id,
      '--max-pages',
      String(job.max_pages || 20),
      '--db',
      DEFAULT_DB_PATH,
      '--output-dir',
      DEFAULT_OUTPUT_DIR,
      '--snapshot-dir',
      path.join(DEFAULT_SNAPSHOT_ROOT, 'yahoo-shopping'),
    ];

    if (job.incremental) args.push('--incremental');
    return args;
  }

  const args = [
    path.join(ROOT_DIR, 'src', 'amazon-poc.js'),
    useUrl ? '--url' : '--asin',
    useUrl ? job.input : job.product_id,
    '--max-pages',
    String(job.max_pages || 20),
    '--db',
    DEFAULT_DB_PATH,
    '--output-dir',
    DEFAULT_OUTPUT_DIR,
    '--snapshot-dir',
    path.join(DEFAULT_SNAPSHOT_ROOT, 'amazon-jp'),
    '--profile-dir',
    DEFAULT_PROFILE_DIR,
    '--manual-resolve',
    '--headful',
    '--minimized',
  ];

  if (job.incremental) args.push('--incremental');
  return args;
}

function startNextJob() {
  if (queuePaused || activeCrawl) return;

  const job = withJobDb((db) => {
    const nextJob = getNextPendingJob(db);
    if (nextJob) markJobRunning(db, nextJob.id);
    return nextJob;
  });

  if (!job) {
    sendJobsChanged({ status: 'idle' });
    return;
  }

  sendJobsChanged({ status: 'running', jobId: job.id, asin: job.product_id, platform: job.platform });
  send('crawl:log', {
    level: 'info',
    time: nowTime(),
    message: `队列启动：${job.platform} / ${job.product_id}，最多 ${job.max_pages} 页`,
  });

  const child = spawn(NODE_BIN, buildCrawlArgs(job), {
    cwd: ROOT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv(),
  });

  activeCrawl = {
    child,
    job,
    stdout: '',
    stderr: '',
    stdoutRest: '',
    stderrRest: '',
  };

  child.stdout.on('data', (chunk) => {
    if (!activeCrawl) return;
    const text = chunk.toString();
    activeCrawl.stdout += text;
    activeCrawl.stdoutRest = splitLines(activeCrawl.stdoutRest, text, (line) => {
      send('crawl:log', { level: 'info', time: nowTime(), message: line });
    });
  });

  child.stderr.on('data', (chunk) => {
    if (!activeCrawl) return;
    const text = chunk.toString();
    activeCrawl.stderr += text;
    activeCrawl.stderrRest = splitLines(activeCrawl.stderrRest, text, (line) => {
      send('crawl:log', { level: 'warn', time: nowTime(), message: line });
    });
  });

  child.on('error', (error) => {
    withJobDb((db) => markJobFailed(db, job.id, error.message));
    activeCrawl = null;
    stoppingJobId = null;
    send('crawl:error', { asin: job.product_id, jobId: job.id, message: error.message });
    sendJobsChanged({ status: 'error', jobId: job.id, asin: job.product_id });
    setTimeout(startNextJob, 250);
  });

  child.on('close', (code) => {
    const current = activeCrawl;
    if (!current) return;

    if (current.stdoutRest.trim()) {
      send('crawl:log', { level: 'info', time: nowTime(), message: current.stdoutRest.trim() });
    }
    if (current.stderrRest.trim()) {
      send('crawl:log', { level: 'warn', time: nowTime(), message: current.stderrRest.trim() });
    }

    const wasStopped = stoppingJobId === job.id;
    activeCrawl = null;
    stoppingJobId = null;

    if (wasStopped) {
      withJobDb((db) => markJobStopped(db, job.id));
      send('crawl:done', { asin: job.product_id, jobId: job.id, result: { status: JOB_STATUSES.STOPPED } });
      sendJobsChanged({ status: JOB_STATUSES.STOPPED, jobId: job.id, asin: job.product_id, platform: job.platform });
      return;
    }

    let result = null;
    try {
      result = parseJsonFromStdout(current.stdout);
    } catch (error) {
      send('crawl:log', {
        level: 'warn',
        time: nowTime(),
        message: `抓取完成，但结果 JSON 解析失败：${error.message}`,
      });
    }

    if (code !== 0 || result?.status !== 'ok') {
      const message = result?.error || result?.stop_reason || current.stderr.trim() || `抓取进程退出，code=${code}`;
      withJobDb((db) => markJobFailed(db, job.id, message, result));
      const resultProductId = result?.product_id || result?.asin || job.product_id;
      send('crawl:error', { asin: resultProductId, jobId: job.id, message });
      sendJobsChanged({ status: JOB_STATUSES.FAILED, jobId: job.id, asin: resultProductId, platform: job.platform });
    } else {
      withJobDb((db) => markJobCompleted(db, job.id, result));
      const resultProductId = result?.product_id || result?.asin || job.product_id;
      send('crawl:done', { asin: resultProductId, jobId: job.id, result });
      sendJobsChanged({ status: JOB_STATUSES.COMPLETED, jobId: job.id, asin: resultProductId, platform: job.platform });
    }

    setTimeout(startNextJob, 350);
  });
}

ipcMain.handle('data:load', async (_event, filters = {}) => {
  const args = ['summary', '--db', DEFAULT_DB_PATH, '--limit', String(filters.limit ?? 80)];
  if (filters.productId) {
    args.push('--product-id', String(filters.productId));
  }

  dataLoadQueue = dataLoadQueue
    .catch(() => undefined)
    .then(() => runNodeJson(path.join(ROOT_DIR, 'src', 'desktop-data.js'), args));
  return dataLoadQueue;
});

ipcMain.handle('jobs:add', async (_event, options = {}) => {
  const result = withJobDb((db) => addJobs(db, options.inputText || options.input || '', options));
  sendJobsChanged({ status: 'queued', result });
  if (options.start !== false) {
    queuePaused = false;
    setTimeout(startNextJob, 0);
  }
  return { status: 'ok', ...result, paused: queuePaused };
});

ipcMain.handle('jobs:start', async () => {
  queuePaused = false;
  setTimeout(startNextJob, 0);
  sendJobsChanged({ status: 'started' });
  return { status: 'started', paused: queuePaused };
});

ipcMain.handle('jobs:pause', async () => {
  queuePaused = true;
  sendJobsChanged({ status: 'paused' });
  return { status: 'paused', running: Boolean(activeCrawl) };
});

ipcMain.handle('jobs:resume', async () => {
  queuePaused = false;
  setTimeout(startNextJob, 0);
  sendJobsChanged({ status: 'resumed' });
  return { status: 'resumed' };
});

ipcMain.handle('jobs:retry', async (_event, jobId) => {
  const changes = withJobDb((db) => requeueJob(db, Number(jobId)));
  queuePaused = false;
  setTimeout(startNextJob, 0);
  sendJobsChanged({ status: 'retry', jobId, changes });
  return { status: 'ok', changes };
});

ipcMain.handle('jobs:retryFailed', async () => {
  const changes = withJobDb((db) => requeueFailedJobs(db));
  queuePaused = false;
  setTimeout(startNextJob, 0);
  sendJobsChanged({ status: 'retryFailed', changes });
  return { status: 'ok', changes };
});

ipcMain.handle('jobs:delete', async (_event, jobId) => {
  const numericJobId = Number(jobId);
  if (activeCrawl?.job.id === numericJobId) {
    return { status: 'error', message: '当前任务正在抓取中，请先停止后再删除队列任务' };
  }

  const changes = withJobDb((db) => markJobDeleted(db, numericJobId));
  sendJobsChanged({ status: 'deleted', jobId: numericJobId, changes });
  return { status: 'ok', changes };
});

ipcMain.handle('jobs:clear', async () => {
  if (activeCrawl) {
    return { status: 'error', message: '当前有任务正在抓取，请先停止后再清空队列' };
  }

  const changes = withJobDb((db) => clearQueueJobs(db));
  sendJobsChanged({ status: 'cleared', changes });
  return { status: 'ok', changes };
});

ipcMain.handle('app:resetAll', async () => {
  if (activeCrawl) {
    return { status: 'error', message: '当前有任务正在抓取，请先停止后再全部重置' };
  }

  withJobDb((db) => resetAllData(db));
  sendJobsChanged({ status: 'resetAll' });
  send('crawl:log', { level: 'warn', time: nowTime(), message: '已全部重置：队列和 SQLite 数据已清空' });
  return { status: 'ok' };
});

ipcMain.handle('crawl:start', async (_event, options = {}) => {
  const input = String(options.input ?? '').trim();
  const asin = parseAsin(input);
  if (!asin) {
    return { status: 'error', message: '请输入有效的 Amazon 商品链接或 ASIN' };
  }

  const result = withJobDb((db) => addJobs(db, input, options));
  queuePaused = false;
  setTimeout(startNextJob, 0);
  sendJobsChanged({ status: 'queued', result });
  return { status: 'started', asin, queued: result.added + result.requeued };
});

ipcMain.handle('crawl:stop', async () => {
  if (!activeCrawl) return { status: 'idle' };
  stoppingJobId = activeCrawl.job.id;
  activeCrawl.child.kill('SIGTERM');
  send('crawl:log', { level: 'warn', time: nowTime(), message: '已请求停止当前抓取任务' });
  return { status: 'stopping' };
});

ipcMain.handle('crawl:manualRetry', async () => {
  if (!activeCrawl?.child.stdin.writable) return { status: 'idle' };
  activeCrawl.child.stdin.write('retry\n');
  send('crawl:log', { level: 'info', time: nowTime(), message: '已发送 retry，继续检测当前页面' });
  return { status: 'sent' };
});

ipcMain.handle('crawl:manualAbort', async () => {
  if (!activeCrawl?.child.stdin.writable) return { status: 'idle' };
  activeCrawl.child.stdin.write('abort\n');
  send('crawl:log', { level: 'warn', time: nowTime(), message: '已发送 abort，中止当前人工处理流程' });
  return { status: 'sent' };
});

ipcMain.handle('export:run', async (_event, options = {}) => {
  const scope = options.scope === 'all' || options.all ? 'all' : 'product';
  const productId = scope === 'product' ? normalizeProductId(options.productId) : '';
  if (scope === 'product' && !productId) {
    return { status: 'error', message: '请选择要导出的商品' };
  }

  const exportName = scope === 'all' ? 'all_platform_reviews.csv' : `${safeFilePart(productId)}_reviews.csv`;
  const dialogTitle = scope === 'all' ? '全量导出评论 CSV' : `导出 ${productId} 评论 CSV`;
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: dialogTitle,
    defaultPath: path.join(app.getPath('downloads'), exportName),
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });

  if (canceled || !filePath) {
    return { status: 'cancelled' };
  }

  const rows = loadReviewRows({ productId });
  writeRowsCsv(filePath, rows);
  const logPrefix = scope === 'all' ? '全量评论' : productId;
  send('crawl:log', { level: 'info', time: nowTime(), message: `${logPrefix} 已导出 CSV：${rows.length} 条评论` });

  if (options.showSuccessDialog) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '导出成功',
      message: '导出成功',
      detail: `已导出 ${rows.length} 条评论到：\n${filePath}`,
      buttons: ['知道了'],
      defaultId: 0,
    });
  }

  return {
    status: 'ok',
    scope,
    product_id: productId,
    reviews: rows.length,
    csvPath: filePath,
    dirPath: path.dirname(filePath),
  };
});

ipcMain.handle('shell:openPath', async (_event, targetPath) => {
  const resolvedPath = path.resolve(ROOT_DIR, String(targetPath || 'exports'));
  return shell.openPath(resolvedPath);
});

ipcMain.handle('app:showMessage', async (_event, options = {}) => {
  return dialog.showMessageBox(mainWindow, {
    type: options.type || 'info',
    title: String(options.title || '提示'),
    message: String(options.message || ''),
    detail: String(options.detail || ''),
    buttons: ['知道了'],
    defaultId: 0,
  });
});

app.whenReady().then(() => {
  withJobDb((db) => {
    seedJobsFromProducts(db);
    recoverRunningJobs(db);
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (activeCrawl) {
    stoppingJobId = activeCrawl.job.id;
    activeCrawl.child.kill('SIGTERM');
    activeCrawl = null;
  }
});
