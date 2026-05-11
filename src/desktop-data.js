import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ensureJobSchema, seedJobsFromProducts } from './job-store.js';

const DEFAULT_DB_PATH = path.resolve('data', 'iceman.sqlite');

function parseArgs(argv) {
  const args = {
    command: argv[0] || 'summary',
    dbPath: DEFAULT_DB_PATH,
    productId: '',
    limit: 80,
  };

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--db') {
      args.dbPath = path.resolve(next ?? DEFAULT_DB_PATH);
      i += 1;
    } else if (token === '--product-id') {
      args.productId = (next ?? '').trim();
      i += 1;
    } else if (token === '--limit') {
      args.limit = Number.parseInt(next ?? '', 10);
      i += 1;
    }
  }

  if (!Number.isFinite(args.limit) || args.limit < 1) args.limit = 80;
  return args;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function countRows(db, tableName) {
  if (!tableExists(db, tableName)) return 0;
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function countVisibleJobs(db) {
  const exists = db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crawl_jobs'
  `).get();
  if (!exists) return 0;
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM crawl_jobs
    WHERE status != 'deleted'
  `).get().count;
}

function isSqliteLockError(error) {
  return error?.errcode === 5 || /database is locked/i.test(String(error?.message || error));
}

function configureDb(db) {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
}

function missingRequiredFields(db) {
  const empty = Object.fromEntries([
    'review_id',
    'review_url',
    'rating',
    'review_title',
    'review_body',
    'reviewer_name',
    'review_date',
  ].map((field) => [field, 0]));
  if (!tableExists(db, 'reviews')) return empty;

  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN review_id IS NULL OR review_id = '' THEN 1 ELSE 0 END) AS review_id,
      SUM(CASE WHEN review_url IS NULL OR review_url = '' THEN 1 ELSE 0 END) AS review_url,
      SUM(CASE WHEN rating IS NULL THEN 1 ELSE 0 END) AS rating,
      SUM(CASE WHEN review_title IS NULL OR review_title = '' THEN 1 ELSE 0 END) AS review_title,
      SUM(CASE WHEN review_body IS NULL OR review_body = '' THEN 1 ELSE 0 END) AS review_body,
      SUM(CASE WHEN reviewer_name IS NULL OR reviewer_name = '' THEN 1 ELSE 0 END) AS reviewer_name,
      SUM(CASE WHEN review_date IS NULL OR review_date = '' THEN 1 ELSE 0 END) AS review_date
    FROM reviews
  `).get();

  return Object.fromEntries(
    Object.entries(row ?? {}).map(([key, value]) => [key, Number(value ?? 0)]),
  );
}

function loadProducts(db) {
  if (!tableExists(db, 'products')) return [];
  return db.prepare(`
    SELECT
      p.platform,
      p.product_id,
      p.product_title,
      p.product_url,
      p.total_rating_count,
      p.total_text_review_count,
      p.first_seen_at,
      p.last_seen_at,
      COUNT(r.review_key) AS stored_review_count,
      lr.id AS latest_run_id,
      lr.status AS latest_status,
      lr.started_at AS latest_started_at,
      lr.finished_at AS latest_finished_at,
      lr.review_count AS latest_review_count,
      lr.inserted_count AS latest_inserted_count,
      lr.updated_count AS latest_updated_count,
      lr.unchanged_count AS latest_unchanged_count,
      lr.stop_reason AS latest_stop_reason,
      lr.error AS latest_error
    FROM products p
    LEFT JOIN reviews r
      ON r.platform = p.platform AND r.product_id = p.product_id
    LEFT JOIN crawl_runs lr
      ON lr.id = (
        SELECT cr.id
        FROM crawl_runs cr
        WHERE cr.platform = p.platform AND cr.product_id = p.product_id
        ORDER BY cr.id DESC
        LIMIT 1
      )
    GROUP BY p.platform, p.product_id
    ORDER BY lr.id DESC, p.last_seen_at DESC, p.product_id
  `).all();
}

function loadReviews(db, { productId, limit }) {
  if (!tableExists(db, 'reviews')) return [];
  const where = productId ? 'WHERE product_id = ?' : '';
  const params = productId ? [productId, limit] : [limit];

  return db.prepare(`
    SELECT
      platform,
      product_id,
      review_key,
      review_id,
      review_url,
      rating,
      rating_text,
      review_title,
      review_body,
      reviewer_name,
      review_date,
      variant,
      verified_purchase,
      helpful_count,
      page_no,
      scraped_at,
      first_seen_at,
      last_seen_at
    FROM reviews
    ${where}
    ORDER BY COALESCE(review_date, '') DESC, last_seen_at DESC, review_id
    LIMIT ?
  `).all(...params);
}

function loadLatestRuns(db) {
  if (!tableExists(db, 'crawl_runs')) return [];
  return db.prepare(`
    SELECT
      id,
      platform,
      product_id,
      status,
      started_at,
      finished_at,
      max_pages,
      stop_reason,
      error,
      review_count,
      inserted_count,
      updated_count,
      unchanged_count,
      json_path,
      csv_path,
      run_path
    FROM crawl_runs
    ORDER BY id DESC
    LIMIT 12
  `).all();
}

function loadJobs(db) {
  ensureJobSchema(db);
  if (!tableExists(db, 'products')) {
    return db.prepare(`
      SELECT
        id,
        platform,
        input,
        product_id,
        status,
        max_pages,
        headful,
        incremental,
        retry_count,
        last_crawl_run_id,
        review_count AS job_review_count,
        inserted_count AS job_inserted_count,
        updated_count AS job_updated_count,
        unchanged_count AS job_unchanged_count,
        stop_reason AS job_stop_reason,
        error_message AS job_error_message,
        created_at,
        updated_at,
        started_at,
        finished_at,
        NULL AS product_title,
        NULL AS product_url,
        NULL AS total_rating_count,
        NULL AS total_text_review_count,
        0 AS stored_review_count,
        NULL AS latest_run_id,
        NULL AS latest_status,
        NULL AS latest_started_at,
        NULL AS latest_finished_at,
        NULL AS latest_review_count,
        NULL AS latest_inserted_count,
        NULL AS latest_updated_count,
        NULL AS latest_unchanged_count,
        NULL AS latest_stop_reason,
        NULL AS latest_error
      FROM crawl_jobs
      WHERE status != 'deleted'
      ORDER BY
        CASE status
          WHEN 'running' THEN 0
          WHEN 'pending' THEN 1
          WHEN 'paused' THEN 2
          WHEN 'failed' THEN 3
          WHEN 'stopped' THEN 4
          WHEN 'completed' THEN 5
          ELSE 6
        END,
        id ASC
    `).all();
  }
  return db.prepare(`
    SELECT
      j.id,
      j.platform,
      j.input,
      j.product_id,
      j.status,
      j.max_pages,
      j.headful,
      j.incremental,
      j.retry_count,
      j.last_crawl_run_id,
      j.review_count AS job_review_count,
      j.inserted_count AS job_inserted_count,
      j.updated_count AS job_updated_count,
      j.unchanged_count AS job_unchanged_count,
      j.stop_reason AS job_stop_reason,
      j.error_message AS job_error_message,
      j.created_at,
      j.updated_at,
      j.started_at,
      j.finished_at,
      p.product_title,
      p.product_url,
      p.total_rating_count,
      p.total_text_review_count,
      COUNT(r.review_key) AS stored_review_count,
      lr.id AS latest_run_id,
      lr.status AS latest_status,
      lr.started_at AS latest_started_at,
      lr.finished_at AS latest_finished_at,
      lr.review_count AS latest_review_count,
      lr.inserted_count AS latest_inserted_count,
      lr.updated_count AS latest_updated_count,
      lr.unchanged_count AS latest_unchanged_count,
      lr.stop_reason AS latest_stop_reason,
      lr.error AS latest_error
    FROM crawl_jobs j
    LEFT JOIN products p
      ON p.platform = j.platform AND p.product_id = j.product_id
    LEFT JOIN reviews r
      ON r.platform = j.platform AND r.product_id = j.product_id
    LEFT JOIN crawl_runs lr
      ON lr.id = COALESCE(
        j.last_crawl_run_id,
        (
          SELECT cr.id
          FROM crawl_runs cr
          WHERE cr.platform = j.platform AND cr.product_id = j.product_id
          ORDER BY cr.id DESC
          LIMIT 1
        )
      )
    WHERE j.status != 'deleted'
    GROUP BY j.id
    ORDER BY
      CASE j.status
        WHEN 'running' THEN 0
        WHEN 'pending' THEN 1
        WHEN 'paused' THEN 2
        WHEN 'failed' THEN 3
        WHEN 'stopped' THEN 4
        WHEN 'completed' THEN 5
        ELSE 6
      END,
      j.id ASC
  `).all();
}

function loadSummary(args) {
  if (!fs.existsSync(args.dbPath)) {
    return {
      status: 'empty',
      dbPath: args.dbPath,
      metrics: {
        products: 0,
        reviews: 0,
        crawl_runs: 0,
        crawl_pages: 0,
        crawl_jobs: 0,
        missing_required_total: 0,
      },
      missing_required_fields: {},
      jobs: [],
      products: [],
      reviews: [],
      latest_runs: [],
    };
  }

  const db = new DatabaseSync(args.dbPath);
  try {
    configureDb(db);
    try {
      ensureJobSchema(db);
      seedJobsFromProducts(db);
    } catch (error) {
      if (!isSqliteLockError(error)) throw error;
    }
    const missingFields = missingRequiredFields(db);
    const missingTotal = Object.values(missingFields).reduce((sum, count) => sum + count, 0);

    return {
      status: 'ok',
      dbPath: args.dbPath,
      metrics: {
        products: countRows(db, 'products'),
        reviews: countRows(db, 'reviews'),
        crawl_runs: countRows(db, 'crawl_runs'),
        crawl_pages: countRows(db, 'crawl_pages'),
        crawl_jobs: countVisibleJobs(db),
        missing_required_total: missingTotal,
      },
      missing_required_fields: missingFields,
      jobs: loadJobs(db),
      products: loadProducts(db),
      reviews: loadReviews(db, args),
      latest_runs: loadLatestRuns(db),
    };
  } finally {
    db.close();
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command !== 'summary') {
    throw new Error(`Unknown desktop data command: ${args.command}`);
  }

  console.log(JSON.stringify(loadSummary(args), null, 2));
}

main();
