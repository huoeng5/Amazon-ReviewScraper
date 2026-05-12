import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  Database,
  Download,
  FileText,
  FolderOpen,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Square,
  Star,
  Terminal,
  Trash2,
} from 'lucide-react';
import type { DesktopDataPayload, DesktopJob, DesktopMetrics, DesktopReview } from './iceman-api';
import './index.css';

type TaskStatus = 'running' | 'completed' | 'empty' | 'queued' | 'paused' | 'failed' | 'stopped';
type TaskFilter = 'all' | TaskStatus | 'problem';

type Task = {
  id: string;
  jobId: number | null;
  platform: string;
  asin: string;
  title: string;
  productUrl: string;
  status: TaskStatus;
  textReviews: number;
  totalTextReviews: number;
  ratingCount: number | null;
  inserted: number;
  updated: number;
  unchanged: number;
  retries: number;
  lastRun: string;
  stopReason: string;
  error: string;
};

type Review = {
  id: string;
  rating: number | null;
  date: string;
  author: string;
  asin: string;
  title: string;
  body: string;
};

type LogLine = {
  id: string;
  time: string;
  level: 'info' | 'warn' | 'error' | 'ok';
  message: string;
};

const EMPTY_METRICS: DesktopMetrics = {
  products: 0,
  reviews: 0,
  crawl_runs: 0,
  crawl_pages: 0,
  crawl_jobs: 0,
  missing_required_total: 0,
};

const statusLabel: Record<TaskStatus, string> = {
  running: '抓取中',
  completed: '完成',
  empty: '无评论',
  queued: '待抓取',
  paused: '已暂停',
  failed: '失败',
  stopped: '已停止',
};

const taskFilterLabel: Record<TaskFilter, string> = {
  all: '全部任务',
  running: '抓取中',
  queued: '待抓取',
  completed: '已完成',
  empty: '无评论',
  failed: '失败',
  stopped: '已停止',
  paused: '已暂停',
  problem: '异常任务',
};

const statusIcon: Record<TaskStatus, ReactNode> = {
  running: <RefreshCw size={14} className="spin" />,
  completed: <CheckCircle2 size={14} />,
  empty: <AlertCircle size={14} />,
  queued: <Clock3 size={14} />,
  paused: <Clock3 size={14} />,
  failed: <AlertCircle size={14} />,
  stopped: <Square size={12} fill="currentColor" />,
};

function currentTime() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function extractAsin(input: string) {
  const text = input.trim();
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

function extractRakutenProductId(input: string) {
  const text = input.trim();
  const directMatch = text.match(/^(\d+)_(\d+)$/);
  if (directMatch) return `${directMatch[1]}_${directMatch[2]}`;

  const reviewMatch = text.match(/review\.rakuten\.co\.jp\/item\/1\/(\d+)_(\d+)(?:\/|$)/i);
  if (reviewMatch) return `${reviewMatch[1]}_${reviewMatch[2]}`;

  const itemMatch = text.match(/item\.rakuten\.co\.jp\/([^/?#]+)\/([^/?#]+)/i);
  if (itemMatch) return `${decodeURIComponent(itemMatch[1])}/${decodeURIComponent(itemMatch[2])}`;

  return '';
}

function extractYahooProductId(input: string) {
  const text = input.trim();
  const directMatch = text.match(/^([a-z0-9-]+)_(.+)$/i);
  if (directMatch && !/^\d+_\d+$/.test(text)) return `${directMatch[1]}_${directMatch[2]}`;

  try {
    const url = new URL(text);
    const storeId = url.searchParams.get('store_id');
    const pageKey = url.searchParams.get('page_key');
    if (storeId && pageKey && /shopping\.yahoo\.co\.jp$/i.test(url.hostname)) {
      return `${storeId}_${pageKey}`;
    }

    const itemMatch = url.hostname === 'store.shopping.yahoo.co.jp'
      ? url.pathname.match(/^\/([^/]+)\/([^/?#]+)\.html$/i)
      : null;
    if (itemMatch) return `${decodeURIComponent(itemMatch[1])}_${decodeURIComponent(itemMatch[2])}`;
  } catch {
    return '';
  }

  return '';
}

function detectInputTarget(input: string) {
  const yahooProductId = extractYahooProductId(input);
  if (yahooProductId) {
    return { platform: 'yahoo_shopping', productId: yahooProductId, label: 'Yahoo!ショッピング商品' };
  }

  const rakutenProductId = extractRakutenProductId(input);
  if (rakutenProductId) {
    return { platform: 'rakuten', productId: rakutenProductId, label: '楽天商品' };
  }

  const asin = extractAsin(input);
  if (asin) {
    return { platform: 'amazon_jp', productId: asin, label: 'Amazon ASIN' };
  }

  return { platform: '', productId: '', label: '' };
}

function formatRunTime(value: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function statusFromJob(job: DesktopJob): TaskStatus {
  if (job.status === 'pending') return 'queued';
  if (job.status === 'running') return 'running';
  if (job.status === 'paused') return 'paused';
  if (job.status === 'failed') return 'failed';
  if (job.status === 'stopped') return 'stopped';
  if (Number(job.stored_review_count ?? 0) === 0 && job.latest_run_id) return 'empty';
  return 'completed';
}

function toTaskFromJob(job: DesktopJob): Task {
  const textReviews = Number(job.stored_review_count ?? job.job_review_count ?? 0);
  const totalTextReviews = Number(job.total_text_review_count ?? textReviews);
  return {
    id: job.product_id,
    jobId: job.id,
    platform: job.platform,
    asin: job.product_id,
    title: job.product_title || job.job_stop_reason || job.input || '待抓取商品',
    productUrl: job.product_url || (job.input.startsWith('http') ? job.input : `https://www.amazon.co.jp/dp/${job.product_id}`),
    status: statusFromJob(job),
    textReviews,
    totalTextReviews,
    ratingCount: job.total_rating_count,
    inserted: Number(job.job_inserted_count ?? job.latest_inserted_count ?? 0),
    updated: Number(job.job_updated_count ?? job.latest_updated_count ?? 0),
    unchanged: Number(job.job_unchanged_count ?? job.latest_unchanged_count ?? 0),
    retries: Number(job.retry_count ?? 0),
    lastRun: formatRunTime(job.finished_at || job.latest_finished_at || job.updated_at),
    stopReason: job.job_stop_reason || job.latest_stop_reason || '',
    error: job.job_error_message || job.latest_error || '',
  };
}

function toReview(review: DesktopReview): Review {
  return {
    id: review.review_id || review.review_key,
    rating: review.rating,
    date: review.review_date || '-',
    author: review.reviewer_name || '-',
    asin: review.product_id,
    title: review.review_title || '-',
    body: review.review_body || '',
  };
}

function settleRunningTask(task: Task): Task {
  if (task.status !== 'running') return task;
  return {
    ...task,
    status: task.textReviews > 0 ? 'completed' : 'empty',
  };
}

function App() {
  const apiAvailable = Boolean(window.iceman);
  const [activeTaskId, setActiveTaskId] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [query, setQuery] = useState('');
  const [taskFilter, setTaskFilter] = useState<TaskFilter>('all');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [metrics, setMetrics] = useState<DesktopMetrics>(EMPTY_METRICS);
  const [dbPath, setDbPath] = useState('');
  const [missingFields, setMissingFields] = useState<Record<string, number>>({});
  const [isLoading, setIsLoading] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [, setQueuePaused] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [lastExportDir, setLastExportDir] = useState('');
  const [lastError, setLastError] = useState('');
  const [logs, setLogs] = useState<LogLine[]>([
    {
      id: 'boot',
      time: currentTime(),
      level: apiAvailable ? 'ok' : 'warn',
      message: apiAvailable ? '桌面接口已连接，正在读取 SQLite 数据' : '当前是浏览器预览模式，未连接 Electron 桌面接口',
    },
  ]);

  const appendLog = useCallback((line: Omit<LogLine, 'id' | 'time'> & { time?: string }) => {
    setLogs((current) => [
      ...current.slice(-119),
      {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        time: line.time || currentTime(),
        level: line.level,
        message: line.message,
      },
    ]);
  }, []);

  const loadData = useCallback(
    async (productId?: string) => {
      if (!window.iceman) return false;
      setIsLoading(true);
      try {
        const payload: DesktopDataPayload = await window.iceman.data.load({
          productId: productId || undefined,
          limit: 120,
        });
        const loadedTasks = payload.jobs.map(toTaskFromJob);
        setTasks(loadedTasks);
        setReviews(payload.reviews.map(toReview));
        setMetrics(payload.metrics);
        setDbPath(payload.dbPath);
        setMissingFields(payload.missing_required_fields);
        setLastError('');

        if (!activeTaskId && loadedTasks[0]) {
          setActiveTaskId(loadedTasks[0].asin);
        }
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLastError(message);
        appendLog({ level: 'error', message: `读取 SQLite 失败：${message}` });
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [activeTaskId, appendLog],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadData(activeTaskId);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [activeTaskId, loadData]);

  useEffect(() => {
    if (!window.iceman) return undefined;

    const offLog = window.iceman.crawl.onLog((payload) => {
      appendLog({
        level: payload.level === 'error' ? 'error' : payload.level,
        time: payload.time,
        message: payload.message,
      });
    });
    const offDone = window.iceman.crawl.onDone((payload) => {
      setIsRunning(false);
      setTasks((current) =>
        current.map((task) => (task.asin === payload.asin ? settleRunningTask(task) : task)),
      );
      appendLog({ level: 'ok', message: `${payload.asin} 抓取完成，已刷新 SQLite 数据` });
      void loadData(payload.asin);
    });
    const offError = window.iceman.crawl.onError((payload) => {
      setIsRunning(false);
      setTasks((current) =>
        current.map((task) => (task.status === 'running' ? { ...task, status: 'failed' } : task)),
      );
      setLastError(payload.message);
      appendLog({ level: 'error', message: payload.message });
      void loadData(activeTaskId);
    });
    const offJobsChanged = window.iceman.jobs.onChanged((payload) => {
      if (typeof payload.paused === 'boolean') setQueuePaused(payload.paused);
      setIsRunning(Boolean(payload.running));
      void loadData(activeTaskId);
    });

    return () => {
      offLog();
      offDone();
      offError();
      offJobsChanged();
    };
  }, [activeTaskId, appendLog, loadData]);

  const activeTask = useMemo(() => {
    const task = tasks.find((item) => item.id === activeTaskId) ?? tasks[0];
    if (task) return task;
    return {
      id: 'empty',
      jobId: null,
      platform: 'amazon_jp',
      asin: '-',
      title: '还没有 SQLite 任务数据',
      productUrl: '',
      status: 'queued' as TaskStatus,
      textReviews: 0,
      totalTextReviews: 0,
      ratingCount: null,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      retries: 0,
      lastRun: '-',
      stopReason: '',
      error: '',
    };
  }, [activeTaskId, tasks]);

  const filteredTasks = useMemo(() => {
    const text = query.trim().toLowerCase();
    return tasks.filter((task) => {
      const matchesText = !text || `${task.asin} ${task.title}`.toLowerCase().includes(text);
      const matchesStatus =
        taskFilter === 'all' ||
        task.status === taskFilter ||
        (taskFilter === 'problem' && ['failed', 'stopped', 'empty'].includes(task.status));
      return matchesText && matchesStatus;
    });
  }, [query, taskFilter, tasks]);

  const completeProducts = tasks.filter((task) => task.status === 'completed').length;
  const pendingTasks = tasks.filter((task) => task.status === 'queued').length;
  const failedTasks = tasks.filter((task) => task.status === 'failed' || task.status === 'stopped').length;
  const progress =
    activeTask.totalTextReviews > 0
      ? Math.min(100, Math.round((activeTask.textReviews / activeTask.totalTextReviews) * 100))
      : activeTask.textReviews > 0 || activeTask.status === 'empty'
        ? 100
        : 0;
  const missingTotal = metrics.missing_required_total ?? Object.values(missingFields).reduce((sum, count) => sum + count, 0);

  async function stopCrawl() {
    if (!window.iceman) return;
    await window.iceman.crawl.stop();
    setIsRunning(false);
    setTasks((current) =>
      current.map((task) => (task.status === 'running' ? settleRunningTask(task) : task)),
    );
  }

  async function manualRetry() {
    await window.iceman?.crawl.manualRetry();
  }

  async function manualAbort() {
    await window.iceman?.crawl.manualAbort();
  }

  async function parseAndStartCrawl() {
    if (!window.iceman) {
      appendLog({ level: 'warn', message: '请通过 npm run desktop 启动桌面版后再执行抓取' });
      return;
    }

    const input = inputValue.trim();
    const target = detectInputTarget(input);
    if (!target.productId) {
      const message = '未识别到有效商品链接，请输入 Amazon 商品链接/ASIN、楽天市場商品链接或 Yahoo!ショッピング商品链接';
      setLastError(message);
      appendLog({ level: 'error', message });
      return;
    }

    if (target.platform === 'amazon_jp') setInputValue(target.productId);
    setActiveTaskId(target.productId);
    setLastError('');
    appendLog({ level: 'info', message: `已解析 ${target.label}：${target.productId}，正在加入队列` });

    const result = await window.iceman.jobs.add({
      inputText: input,
      maxPages: 20,
      headful: target.platform === 'amazon_jp',
      incremental: false,
      start: true,
    });

    if (result.status !== 'ok') {
      const message = String(result.message || '加入队列失败');
      setLastError(message);
      appendLog({ level: 'error', message });
      return;
    }

    const added = Number(result.added ?? 0);
    const requeued = Number(result.requeued ?? 0);
    const skipped = Number(result.skipped ?? 0);
    if (skipped > 0 && added === 0 && requeued === 0) {
      const message = '该网址已在队列';
      setLastError(message);
      appendLog({ level: 'warn', message: `${target.productId} ${message}` });
      await window.iceman.app.showMessage({
        type: 'warning',
        title: '重复任务',
        message,
        detail: '请勿重复添加同一个商品链接。你可以在左侧任务列表中查看当前状态。',
      });
      void loadData(target.productId);
      return;
    }

    appendLog({
      level: 'ok',
      message: `队列已更新：新增 ${String(added)}，重新排队 ${String(requeued)}，跳过 ${String(skipped)}`,
    });
    void loadData(target.productId);
  }

  async function retryQueueTask(task: Task) {
    if (!window.iceman || task.jobId == null) return;
    const result = await window.iceman.jobs.retry(task.jobId);
    if (result.status !== 'ok') {
      const message = String(result.message || '重试任务失败');
      setLastError(message);
      appendLog({ level: 'error', message });
      return;
    }

    appendLog({ level: 'info', message: `${task.asin} 已重新加入队列，准备单独同步` });
    setActiveTaskId(task.asin);
    void loadData(task.asin);
  }

  async function deleteQueueTask(task: Task) {
    if (!window.iceman || task.jobId == null) return;
    if (task.status === 'running') {
      setLastError('当前任务正在抓取中，请先停止后再删除队列任务');
      return;
    }

    const confirmed = window.confirm(
      `只删除队列任务 ${task.asin}，不会删除 SQLite 中已抓取的商品和评论数据。是否继续？`,
    );
    if (!confirmed) return;

    const result = await window.iceman.jobs.delete(task.jobId);
    if (result.status !== 'ok') {
      const message = String(result.message || '删除队列任务失败');
      setLastError(message);
      appendLog({ level: 'error', message });
      return;
    }

    appendLog({
      level: 'ok',
      message: `${task.asin} 已从队列移除，SQLite 评论数据已保留`,
    });
    setTasks((current) => current.filter((item) => item.jobId !== task.jobId));
    if (activeTaskId === task.id) setActiveTaskId('');
    void loadData('');
  }

  async function clearQueue() {
    if (!window.iceman) return;
    const confirmed = window.confirm('确认清空队列吗？这只会软删除队列任务，不会删除 SQLite 里的商品、评论和抓取记录。');
    if (!confirmed) return;

    const result = await window.iceman.jobs.clear();
    if (result.status !== 'ok') {
      const message = String(result.message || '清空队列失败');
      setLastError(message);
      appendLog({ level: 'error', message });
      return;
    }

    appendLog({ level: 'ok', message: `已清空队列：${String(result.changes ?? 0)} 个任务已移除，数据库数据保留` });
    setActiveTaskId('');
    void loadData('');
  }

  async function resetAll() {
    if (!window.iceman) return;
    const confirmed = window.confirm(
      '确认全部重置吗？这会删除队列以及 SQLite 中的商品、评论、抓取记录和分页诊断数据。此操作不可撤销。',
    );
    if (!confirmed) return;

    const result = await window.iceman.app.resetAll();
    if (result.status !== 'ok') {
      const message = String(result.message || '全部重置失败');
      setLastError(message);
      appendLog({ level: 'error', message });
      return;
    }

    appendLog({ level: 'warn', message: '已全部重置：队列和 SQLite 数据已清空' });
    setActiveTaskId('');
    void loadData('');
  }

  async function runExport() {
    if (!window.iceman) {
      appendLog({ level: 'warn', message: '请通过桌面版执行导出' });
      return;
    }
    if (!activeTask.asin || activeTask.asin === '-') {
      setLastError('请先选择一个商品再导出');
      return;
    }

    setIsExporting(true);
    try {
      const result = await window.iceman.export.run({ productId: activeTask.asin });
      if (result.status === 'cancelled') return;
      if (result.status !== 'ok') {
        const message = String(result.message || '导出失败');
        setLastError(message);
        appendLog({ level: 'error', message });
        return;
      }
      setLastExportDir(String(result.dirPath || ''));
      appendLog({
        level: 'ok',
        message: `${activeTask.asin} 导出完成：${String(result.reviews ?? 0)} 条评论`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      appendLog({ level: 'error', message: `导出失败：${message}` });
    } finally {
      setIsExporting(false);
    }
  }

  async function runFullExport() {
    if (!window.iceman) {
      appendLog({ level: 'warn', message: '请通过桌面版执行导出' });
      return;
    }

    setIsExporting(true);
    try {
      const result = await window.iceman.export.run({ scope: 'all', showSuccessDialog: true });
      if (result.status === 'cancelled') return;
      if (result.status !== 'ok') {
        const message = String(result.message || '全量导出失败');
        setLastError(message);
        appendLog({ level: 'error', message });
        return;
      }
      setLastExportDir(String(result.dirPath || ''));
      appendLog({
        level: 'ok',
        message: `全量导出完成：${String(result.reviews ?? 0)} 条评论`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      appendLog({ level: 'error', message: `全量导出失败：${message}` });
    } finally {
      setIsExporting(false);
    }
  }

  async function openExports() {
    if (!lastExportDir) return;
    await window.iceman?.shell.openPath(lastExportDir);
  }

  async function refreshTaskPane() {
    const refreshed = await loadData(activeTaskId);
    if (!refreshed) return;
    appendLog({ level: 'ok', message: '任务队列已刷新' });
    await window.iceman?.app.showMessage({
      type: 'info',
      title: '刷新成功',
      message: '刷新成功',
      detail: '已读取最新 SQLite 数据。',
    });
  }

  return (
    <div className="desktop-shell">
      <aside className="rail">
        <div className="brand">
          <div className="brand-mark">IC</div>
          <div>
            <div className="brand-name">ICEMAN</div>
            <div className="brand-subtitle">Review Crawler</div>
          </div>
        </div>

        <nav className="nav-stack" aria-label="Primary">
          <button className="nav-button active" title="Dashboard">
            <Database size={18} />
          </button>
          <button className="nav-button" title="全量导出" onClick={runFullExport} disabled={isExporting}>
            <Download size={18} />
          </button>
          {lastExportDir && (
            <button className="nav-button" title="Open export folder" onClick={openExports}>
              <FileText size={18} />
            </button>
          )}
          <button className="nav-button" title="Session">
            <ShieldCheck size={18} />
          </button>
        </nav>

        <div className="session-card">
          <div className={`session-dot ${apiAvailable ? '' : 'offline'}`} />
          <div>
            <div className="session-title">Amazon JP</div>
            <div className="session-state">{apiAvailable ? 'Profile ready' : 'Preview'}</div>
          </div>
        </div>
      </aside>

      <section className="task-pane">
        <div className="pane-header">
          <div>
            <div className="eyebrow">任务队列</div>
            <h1>商品采集</h1>
          </div>
          <button className="icon-button" title="刷新数据" onClick={() => void refreshTaskPane()}>
            <RefreshCw size={18} className={isLoading ? 'spin' : ''} />
          </button>
        </div>

        <div className="search-box">
          <Search size={15} />
          <input
            type="search"
            placeholder="筛选 ASIN 或商品名"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="queue-tools" aria-label="Queue actions">
          <button className="queue-tool-button" onClick={clearQueue} title="清空队列，不删除 SQLite 数据">
            <Trash2 size={15} />
          </button>
          <button className="queue-tool-button danger" onClick={resetAll} title="全部重置，删除队列和 SQLite 数据">
            <RotateCcw size={15} />
          </button>
        </div>

        <div className="task-filter-bar">
          <label htmlFor="task-filter">任务状态</label>
          <select
            id="task-filter"
            value={taskFilter}
            onChange={(event) => setTaskFilter(event.target.value as TaskFilter)}
          >
            {Object.entries(taskFilterLabel).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <span>{filteredTasks.length}/{tasks.length}</span>
        </div>

        <div className="task-list-shell">
          <div className="task-list">
            {filteredTasks.map((task) => (
              <div
                className={`task-row ${task.id === activeTask.id ? 'selected' : ''}`}
                key={task.id}
              >
                <button className="task-main" onClick={() => setActiveTaskId(task.id)}>
                  <div className="task-row-top">
                    <span className="asin">{task.asin}</span>
                  </div>
                  <div className="task-title">{task.title}</div>
                  <div className="task-row-bottom">
                    <span>{task.textReviews}/{task.totalTextReviews || 0} 评论</span>
                    <span className={`status-pill ${task.status}`}>
                      {statusIcon[task.status]}
                      {statusLabel[task.status]}
                    </span>
                  </div>
                </button>
                {task.jobId != null && (
                  <div className="task-card-actions">
                    <button
                      className="task-action-button delete"
                      onClick={() => void deleteQueueTask(task)}
                      disabled={task.status === 'running'}
                      title="只删除队列任务，不删除 SQLite 评论数据"
                    >
                      <Trash2 size={12} />
                      删除
                    </button>
                    {task.status === 'failed' && (
                      <button
                        className="task-action-button retry"
                        onClick={() => void retryQueueTask(task)}
                        title="单独重试同步当前任务"
                      >
                        <RefreshCw size={12} />
                        重试
                      </button>
                    )}
                  </div>
                )}
              </div>
            ))}

            {!filteredTasks.length && (
              <div className="empty-state">
                <AlertCircle size={16} />
                <span>{isLoading ? '正在读取 SQLite...' : '暂无任务数据'}</span>
              </div>
            )}
          </div>
        </div>
      </section>

      <main className="workspace">
        <header className="command-bar">
          <div>
            <div className="eyebrow">Amazon Japan</div>
            <h2>评论抓取工作台</h2>
          </div>
          <div className="command-actions">
            {isRunning ? (
              <>
                <button className="secondary-action" onClick={manualRetry}>
                  <CheckCircle2 size={15} />
                  已处理继续
                </button>
                <button className="secondary-action" onClick={manualAbort}>
                  <AlertCircle size={15} />
                  人工中止
                </button>
                <button className="danger-action" onClick={stopCrawl}>
                  <Square size={14} fill="currentColor" />
                  停止
                </button>
              </>
            ) : null}
          </div>
        </header>

        <section className="input-strip">
          <Search size={17} />
          <textarea
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
            placeholder="粘贴 Amazon 商品链接或 ASIN"
          />
          <button onClick={parseAndStartCrawl}>解析并抓取</button>
        </section>

        {lastError && (
          <section className="alert-strip">
            <AlertCircle size={16} />
            <span>{lastError}</span>
          </section>
        )}

        <section className="metric-grid">
          <div className="metric-card">
            <span>队列任务</span>
            <strong>{tasks.length || metrics.crawl_jobs || metrics.products}</strong>
            <em>{completeProducts} 完成 / {pendingTasks} 待抓 / {failedTasks} 失败</em>
          </div>
          <div className="metric-card">
            <span>已入库评论</span>
            <strong>{metrics.reviews}</strong>
            <em>字段缺失 {missingTotal}</em>
          </div>
          <div className="metric-card">
            <span>当前进度</span>
            <strong>{progress}%</strong>
            <em>{activeTask.textReviews}/{activeTask.totalTextReviews || 0} 条公开文字评论</em>
          </div>
          <div className="metric-card">
            <span>最近运行</span>
            <strong>{activeTask.lastRun}</strong>
            <em>{statusLabel[activeTask.status]}</em>
          </div>
        </section>

        <section className="data-panel">
          <div className="section-header">
            <div>
              <h3>评论预览</h3>
              <p>{dbPath ? `SQLite: ${dbPath}` : '来自 SQLite 的最近评论明细'}</p>
            </div>
            <div className="panel-actions">
              {lastExportDir && (
                <button className="ghost-action" onClick={openExports}>
                  <FolderOpen size={15} />
                  打开导出目录
                </button>
              )}
              <button className="ghost-action" onClick={runExport} disabled={isExporting}>
                <Download size={15} />
                {isExporting ? '导出中' : '导出当前商品 CSV'}
              </button>
            </div>
          </div>

          <div className="table-wrap">
            <table className="review-table">
              <thead>
                <tr>
                  <th>评分</th>
                  <th>日期</th>
                  <th>作者</th>
                  <th>ASIN</th>
                  <th>标题</th>
                  <th>评论摘要</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((review) => (
                  <tr key={review.id}>
                    <td>
                      <span className="rating-badge">
                        <Star size={13} fill="currentColor" />
                        {review.rating ?? '-'}
                      </span>
                    </td>
                    <td>{review.date}</td>
                    <td className="strong-cell">{review.author}</td>
                    <td className="mono-cell">{review.asin}</td>
                    <td>{review.title}</td>
                    <td className="clip-cell">{review.body}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!reviews.length && (
              <div className="table-empty">
                <AlertCircle size={17} />
                <span>当前商品暂无已入库评论</span>
              </div>
            )}
          </div>
        </section>

        <section className="log-dock">
          <div className="log-title">
            <Terminal size={15} />
            运行日志
          </div>
          <div className="log-lines">
            {logs.map((log) => (
              <p key={log.id}>
                <time>{log.time}</time>
                <span className={log.level}>{log.level.toUpperCase()}</span>
                {log.message}
              </p>
            ))}
          </div>
        </section>
      </main>

      <aside className="inspector">
        <div className="inspector-header">
          <div>
            <div className="eyebrow">当前商品</div>
            <h3>{activeTask.asin}</h3>
          </div>
        </div>

        <dl className="product-info-list">
          <div>
            <dt>商品标题</dt>
            <dd>{activeTask.title}</dd>
          </div>
          <div>
            <dt>商品链接</dt>
            <dd className="product-link-text">{activeTask.productUrl || '-'}</dd>
          </div>
        </dl>
      </aside>
    </div>
  );
}

export default App;
