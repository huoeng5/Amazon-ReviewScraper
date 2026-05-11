import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const PLATFORM = 'amazon_jp';
export const PLATFORMS = {
  AMAZON_JP: 'amazon_jp',
  RAKUTEN: 'rakuten',
  YAHOO_SHOPPING: 'yahoo_shopping',
};
export const JOB_STATUSES = {
  PENDING: 'pending',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  STOPPED: 'stopped',
  DELETED: 'deleted',
};

export function openJobStore(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.path = dbPath;
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  ensureJobSchema(db);
  return db;
}

export function closeJobStore(db) {
  db?.close();
}

export function ensureJobSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS crawl_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'amazon_jp',
      input TEXT NOT NULL,
      product_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      max_pages INTEGER NOT NULL DEFAULT 20,
      headful INTEGER NOT NULL DEFAULT 1,
      incremental INTEGER NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_crawl_run_id INTEGER,
      review_count INTEGER NOT NULL DEFAULT 0,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      stop_reason TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      UNIQUE(platform, product_id)
    );

    CREATE INDEX IF NOT EXISTS idx_crawl_jobs_status_id
      ON crawl_jobs(status, id);
  `);
}

export function extractAsin(input) {
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

export function extractRakutenProductId(input) {
  const text = String(input ?? '').trim();
  const directMatch = text.match(/^(\d+)_(\d+)$/);
  if (directMatch) return `${directMatch[1]}_${directMatch[2]}`;

  const reviewMatch = text.match(/review\.rakuten\.co\.jp\/item\/1\/(\d+)_(\d+)(?:\/|$)/i);
  if (reviewMatch) return `${reviewMatch[1]}_${reviewMatch[2]}`;

  const itemMatch = text.match(/item\.rakuten\.co\.jp\/([^/?#]+)\/([^/?#]+)/i);
  if (itemMatch) {
    return `${decodeURIComponent(itemMatch[1])}/${decodeURIComponent(itemMatch[2])}`;
  }

  return '';
}

export function extractYahooProductId(input) {
  const text = String(input ?? '').trim();
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

export function detectJobTarget(input) {
  const yahooProductId = extractYahooProductId(input);
  if (yahooProductId) {
    return { platform: PLATFORMS.YAHOO_SHOPPING, productId: yahooProductId };
  }

  const rakutenProductId = extractRakutenProductId(input);
  if (rakutenProductId) {
    return { platform: PLATFORMS.RAKUTEN, productId: rakutenProductId };
  }

  const asin = extractAsin(input);
  if (asin) {
    return { platform: PLATFORMS.AMAZON_JP, productId: asin };
  }

  return { platform: '', productId: '' };
}

export function splitJobInputs(inputText) {
  return String(inputText ?? '')
    .split(/[\n\r\t,，]+/)
    .map((line) => line.trim())
    .filter((line) => line && !/^asin\s*$/i.test(line));
}

export function addJobs(db, inputText, options = {}) {
  const now = new Date().toISOString();
  const maxPages = Math.max(1, Number.parseInt(String(options.maxPages ?? 20), 10) || 20);
  const headful = options.headful === false ? 0 : 1;
  const incremental = options.incremental ? 1 : 0;
  const items = splitJobInputs(inputText);
  const result = {
    added: 0,
    requeued: 0,
    skipped: 0,
    invalid: 0,
    jobs: [],
    skipped_items: [],
    invalid_items: [],
  };

  const selectJob = db.prepare('SELECT * FROM crawl_jobs WHERE platform = ? AND product_id = ?');
  const insertJob = db.prepare(`
    INSERT INTO crawl_jobs (
      platform, input, product_id, status, max_pages, headful, incremental,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const requeueJob = db.prepare(`
    UPDATE crawl_jobs SET
      input = ?,
      status = ?,
      max_pages = ?,
      headful = ?,
      incremental = ?,
      stop_reason = NULL,
      error_message = NULL,
      updated_at = ?,
      started_at = NULL,
      finished_at = NULL
    WHERE id = ?
  `);

  for (const item of items) {
    const target = detectJobTarget(item);
    if (!target.productId) {
      result.invalid += 1;
      result.invalid_items.push(item);
      continue;
    }

    const existing = selectJob.get(target.platform, target.productId);
    if (!existing) {
      const insertResult = insertJob.run(
        target.platform,
        item,
        target.productId,
        JOB_STATUSES.PENDING,
        maxPages,
        headful,
        incremental,
        now,
        now,
      );
      result.added += 1;
      result.jobs.push({
        id: Number(insertResult.lastInsertRowid),
        platform: target.platform,
        product_id: target.productId,
        status: JOB_STATUSES.PENDING,
      });
      continue;
    }

    if ([JOB_STATUSES.FAILED, JOB_STATUSES.STOPPED, JOB_STATUSES.DELETED].includes(existing.status)) {
      requeueJob.run(item, JOB_STATUSES.PENDING, maxPages, headful, incremental, now, existing.id);
      result.requeued += 1;
      result.jobs.push({
        id: existing.id,
        platform: target.platform,
        product_id: target.productId,
        status: JOB_STATUSES.PENDING,
      });
      continue;
    }

    result.skipped += 1;
    result.skipped_items.push({
      input: item,
      platform: target.platform,
      product_id: target.productId,
      status: existing.status,
    });
  }

  return result;
}

export function getNextPendingJob(db) {
  return db.prepare(`
    SELECT *
    FROM crawl_jobs
    WHERE status = ?
    ORDER BY id ASC
    LIMIT 1
  `).get(JOB_STATUSES.PENDING);
}

export function markJobRunning(db, jobId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE crawl_jobs SET
      status = ?,
      started_at = ?,
      finished_at = NULL,
      updated_at = ?,
      error_message = NULL,
      stop_reason = NULL
    WHERE id = ?
  `).run(JOB_STATUSES.RUNNING, now, now, jobId);
}

export function markJobCompleted(db, jobId, result) {
  const now = new Date().toISOString();
  const resolvedProductId = result?.product_id || result?.asin || null;
  const conflictingJob = resolvedProductId
    ? db.prepare(`
      SELECT other.id
      FROM crawl_jobs current
      JOIN crawl_jobs other
        ON other.platform = current.platform
       AND other.product_id = ?
       AND other.id != current.id
      WHERE current.id = ?
      LIMIT 1
    `).get(resolvedProductId, jobId)
    : null;
  const productIdToStore = conflictingJob ? null : resolvedProductId;

  db.prepare(`
    UPDATE crawl_jobs SET
      status = ?,
      product_id = COALESCE(?, product_id),
      last_crawl_run_id = ?,
      review_count = ?,
      inserted_count = ?,
      updated_count = ?,
      unchanged_count = ?,
      stop_reason = ?,
      error_message = ?,
      finished_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    JOB_STATUSES.COMPLETED,
    productIdToStore,
    result?.crawl_run_id || null,
    Number(result?.reviews ?? 0),
    Number(result?.db_inserted ?? 0),
    Number(result?.db_updated ?? 0),
    Number(result?.db_unchanged ?? 0),
    result?.stop_reason || '',
    result?.error || '',
    now,
    now,
    jobId,
  );
}

export function markJobFailed(db, jobId, message, result = null) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE crawl_jobs SET
      status = ?,
      last_crawl_run_id = COALESCE(?, last_crawl_run_id),
      review_count = COALESCE(?, review_count),
      inserted_count = COALESCE(?, inserted_count),
      updated_count = COALESCE(?, updated_count),
      unchanged_count = COALESCE(?, unchanged_count),
      stop_reason = ?,
      error_message = ?,
      retry_count = retry_count + 1,
      finished_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    JOB_STATUSES.FAILED,
    result?.crawl_run_id || null,
    result?.reviews == null ? null : Number(result.reviews),
    result?.db_inserted == null ? null : Number(result.db_inserted),
    result?.db_updated == null ? null : Number(result.db_updated),
    result?.db_unchanged == null ? null : Number(result.db_unchanged),
    result?.stop_reason || message,
    message,
    now,
    now,
    jobId,
  );
}

export function markJobStopped(db, jobId, message = 'Stopped by user') {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE crawl_jobs SET
      status = ?,
      stop_reason = ?,
      error_message = ?,
      finished_at = ?,
      updated_at = ?
    WHERE id = ?
  `).run(JOB_STATUSES.STOPPED, message, message, now, now, jobId);
}

export function requeueJob(db, jobId) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE crawl_jobs SET
      status = ?,
      stop_reason = NULL,
      error_message = NULL,
      started_at = NULL,
      finished_at = NULL,
      updated_at = ?
    WHERE id = ? AND status IN (?, ?, ?)
  `).run(JOB_STATUSES.PENDING, now, jobId, JOB_STATUSES.FAILED, JOB_STATUSES.STOPPED, JOB_STATUSES.DELETED);
  return result.changes;
}

export function markJobDeleted(db, jobId) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE crawl_jobs SET
      status = ?,
      stop_reason = ?,
      error_message = NULL,
      updated_at = ?,
      finished_at = COALESCE(finished_at, ?)
    WHERE id = ? AND status != ?
  `).run(JOB_STATUSES.DELETED, 'Deleted from queue only; stored review data preserved', now, now, jobId, JOB_STATUSES.RUNNING);
  return result.changes;
}

export function clearQueueJobs(db) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE crawl_jobs SET
      status = ?,
      stop_reason = ?,
      error_message = NULL,
      updated_at = ?,
      finished_at = COALESCE(finished_at, ?)
    WHERE status != ?
  `).run(
    JOB_STATUSES.DELETED,
    'Queue cleared; stored review data preserved',
    now,
    now,
    JOB_STATUSES.DELETED,
  );
  return result.changes;
}

export function resetAllData(db) {
  ensureJobSchema(db);
  db.exec('BEGIN');
  try {
    db.exec(`
      DELETE FROM crawl_pages;
      DELETE FROM reviews;
      DELETE FROM crawl_runs;
      DELETE FROM products;
      DELETE FROM crawl_jobs;
      DELETE FROM sqlite_sequence
        WHERE name IN ('crawl_runs', 'crawl_jobs');
    `);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function requeueFailedJobs(db) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE crawl_jobs SET
      status = ?,
      stop_reason = NULL,
      error_message = NULL,
      started_at = NULL,
      finished_at = NULL,
      updated_at = ?
    WHERE status IN (?, ?)
  `).run(JOB_STATUSES.PENDING, now, JOB_STATUSES.FAILED, JOB_STATUSES.STOPPED);
  return result.changes;
}

export function recoverRunningJobs(db) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE crawl_jobs SET
      status = ?,
      error_message = ?,
      updated_at = ?
    WHERE status = ?
  `).run(JOB_STATUSES.PENDING, 'Recovered after app restart', now, JOB_STATUSES.RUNNING);
  return result.changes;
}

export function seedJobsFromProducts(db) {
  ensureJobSchema(db);
  const hasProducts = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'products'
  `).get();
  if (!hasProducts) return 0;
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT OR IGNORE INTO crawl_jobs (
      platform,
      input,
      product_id,
      status,
      max_pages,
      headful,
      incremental,
      retry_count,
      last_crawl_run_id,
      review_count,
      inserted_count,
      updated_count,
      unchanged_count,
      stop_reason,
      error_message,
      created_at,
      updated_at,
      started_at,
      finished_at
    )
    SELECT
      p.platform,
      COALESCE(NULLIF(p.product_url, ''), p.product_id),
      p.product_id,
      CASE
        WHEN lr.status = 'ok' THEN 'completed'
        WHEN lr.id IS NULL THEN 'completed'
        ELSE 'failed'
      END,
      COALESCE(lr.max_pages, 20),
      1,
      0,
      0,
      lr.id,
      COALESCE(lr.review_count, 0),
      COALESCE(lr.inserted_count, 0),
      COALESCE(lr.updated_count, 0),
      COALESCE(lr.unchanged_count, 0),
      COALESCE(lr.stop_reason, ''),
      COALESCE(lr.error, ''),
      COALESCE(lr.started_at, p.first_seen_at, ?),
      COALESCE(p.last_seen_at, lr.finished_at, ?),
      lr.started_at,
      lr.finished_at
    FROM products p
    LEFT JOIN crawl_runs lr
      ON lr.id = (
        SELECT cr.id
        FROM crawl_runs cr
        WHERE cr.platform = p.platform AND cr.product_id = p.product_id
        ORDER BY cr.id DESC
        LIMIT 1
      )
  `).run(now, now);
  return result.changes;
}
