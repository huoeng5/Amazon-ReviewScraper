import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

function reviewKeyOf(review) {
  return review.review_id || `${review.asin}:${review.review_date}:${review.reviewer_name}:${review.review_body}`;
}

function boolToInt(value) {
  return value ? 1 : 0;
}

function comparableReviewJson(review) {
  const stableReview = { ...review };
  delete stableReview.scraped_at;
  delete stableReview.page_no;
  return JSON.stringify(stableReview);
}

function runTransaction(db, callback) {
  db.exec('BEGIN');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openStorage(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.path = dbPath;
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function closeStorage(db) {
  db?.close();
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      platform TEXT NOT NULL,
      product_id TEXT NOT NULL,
      product_title TEXT,
      product_url TEXT,
      total_rating_count INTEGER,
      total_text_review_count INTEGER,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (platform, product_id)
    );

    CREATE TABLE IF NOT EXISTS reviews (
      platform TEXT NOT NULL,
      product_id TEXT NOT NULL,
      review_key TEXT NOT NULL,
      review_id TEXT,
      review_url TEXT,
      rating REAL,
      rating_text TEXT,
      review_title TEXT,
      review_title_raw TEXT,
      review_body TEXT,
      reviewer_name TEXT,
      review_date TEXT,
      variant TEXT,
      verified_purchase INTEGER,
      helpful_count TEXT,
      page_no INTEGER,
      scraped_at TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_json TEXT NOT NULL,
      PRIMARY KEY (platform, product_id, review_key),
      FOREIGN KEY (platform, product_id) REFERENCES products(platform, product_id)
    );

    CREATE TABLE IF NOT EXISTS crawl_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      product_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      max_pages INTEGER,
      stop_reason TEXT,
      error TEXT,
      review_count INTEGER NOT NULL,
      inserted_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      json_path TEXT,
      csv_path TEXT,
      run_path TEXT,
      raw_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS crawl_pages (
      crawl_run_id INTEGER NOT NULL,
      page_no INTEGER NOT NULL,
      status TEXT,
      url TEXT,
      count INTEGER,
      review_container_count INTEGER,
      visible_review_count INTEGER,
      total_rating_count INTEGER,
      total_text_review_count INTEGER,
      next_page_available INTEGER,
      next_page_mode TEXT,
      quality_json TEXT,
      PRIMARY KEY (crawl_run_id, page_no),
      FOREIGN KEY (crawl_run_id) REFERENCES crawl_runs(id)
    );

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

export function getKnownReviewKeys(db, platform, productId) {
  const rows = db
    .prepare('SELECT review_key FROM reviews WHERE platform = ? AND product_id = ?')
    .all(platform, productId);
  return new Set(rows.map((row) => row.review_key));
}

export function saveCrawlResult(db, { run, reviews, jsonPath, csvPath, runPath }) {
  const now = new Date().toISOString();
  const platform = run.platform;
  const productId = run.asin;
  const productTitle = reviews.find((review) => review.product_title)?.product_title || '';
  const totalRatingCount = run.page_results.find((page) => page.total_rating_count != null)?.total_rating_count ?? null;
  const totalTextReviewCount =
    run.page_results.find((page) => page.total_text_review_count != null)?.total_text_review_count ?? null;

  const existingProduct = db
    .prepare('SELECT first_seen_at FROM products WHERE platform = ? AND product_id = ?')
    .get(platform, productId);

  db.prepare(`
    INSERT INTO products (
      platform, product_id, product_title, product_url, total_rating_count, total_text_review_count,
      first_seen_at, last_seen_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, product_id) DO UPDATE SET
      product_title = excluded.product_title,
      product_url = excluded.product_url,
      total_rating_count = excluded.total_rating_count,
      total_text_review_count = excluded.total_text_review_count,
      last_seen_at = excluded.last_seen_at
  `).run(
    platform,
    productId,
    productTitle,
    run.product_url,
    totalRatingCount,
    totalTextReviewCount,
    existingProduct?.first_seen_at ?? now,
    now,
  );

  const stats = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
  };

  const selectReview = db.prepare(
    'SELECT raw_json FROM reviews WHERE platform = ? AND product_id = ? AND review_key = ?',
  );
  const insertReview = db.prepare(`
    INSERT INTO reviews (
      platform, product_id, review_key, review_id, review_url, rating, rating_text, review_title,
      review_title_raw, review_body, reviewer_name, review_date, variant, verified_purchase,
      helpful_count, page_no, scraped_at, first_seen_at, last_seen_at, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateReview = db.prepare(`
    UPDATE reviews SET
      review_id = ?,
      review_url = ?,
      rating = ?,
      rating_text = ?,
      review_title = ?,
      review_title_raw = ?,
      review_body = ?,
      reviewer_name = ?,
      review_date = ?,
      variant = ?,
      verified_purchase = ?,
      helpful_count = ?,
      page_no = ?,
      scraped_at = ?,
      last_seen_at = ?,
      raw_json = ?
    WHERE platform = ? AND product_id = ? AND review_key = ?
  `);

  runTransaction(db, () => {
    for (const review of reviews) {
      const reviewKey = reviewKeyOf(review);
      const rawJson = JSON.stringify(review);
      const comparableJson = comparableReviewJson(review);
      const existing = selectReview.get(platform, productId, reviewKey);

      if (!existing) {
        insertReview.run(
          platform,
          productId,
          reviewKey,
          review.review_id,
          review.review_url,
          review.rating,
          review.rating_text,
          review.review_title,
          review.review_title_raw,
          review.review_body,
          review.reviewer_name,
          review.review_date,
          review.variant,
          boolToInt(review.verified_purchase),
          review.helpful_count,
          review.page_no,
          review.scraped_at,
          now,
          now,
          rawJson,
        );
        stats.inserted += 1;
      } else if (comparableReviewJson(JSON.parse(existing.raw_json)) !== comparableJson) {
        updateReview.run(
          review.review_id,
          review.review_url,
          review.rating,
          review.rating_text,
          review.review_title,
          review.review_title_raw,
          review.review_body,
          review.reviewer_name,
          review.review_date,
          review.variant,
          boolToInt(review.verified_purchase),
          review.helpful_count,
          review.page_no,
          review.scraped_at,
          now,
          rawJson,
          platform,
          productId,
          reviewKey,
        );
        stats.updated += 1;
      } else {
        db.prepare(`
          UPDATE reviews SET last_seen_at = ? WHERE platform = ? AND product_id = ? AND review_key = ?
        `).run(now, platform, productId, reviewKey);
        stats.unchanged += 1;
      }
    }
  });

  const runInsert = db.prepare(`
    INSERT INTO crawl_runs (
      platform, product_id, status, started_at, finished_at, max_pages, stop_reason, error,
      review_count, inserted_count, updated_count, unchanged_count, json_path, csv_path, run_path, raw_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const runResult = runInsert.run(
    platform,
    productId,
    run.status,
    run.started_at,
    run.finished_at,
    run.max_pages,
    run.stop_reason,
    run.error,
    reviews.length,
    stats.inserted,
    stats.updated,
    stats.unchanged,
    jsonPath,
    csvPath,
    runPath,
    JSON.stringify(run),
  );

  const crawlRunId = Number(runResult.lastInsertRowid);
  const pageInsert = db.prepare(`
    INSERT INTO crawl_pages (
      crawl_run_id, page_no, status, url, count, review_container_count, visible_review_count,
      total_rating_count, total_text_review_count, next_page_available, next_page_mode, quality_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  runTransaction(db, () => {
    for (const page of run.page_results) {
      pageInsert.run(
        crawlRunId,
        page.page_no,
        page.status,
        page.url,
        page.count,
        page.review_container_count ?? null,
        page.visible_review_count ?? null,
        page.total_rating_count ?? null,
        page.total_text_review_count ?? null,
        page.next_page_available == null ? null : boolToInt(page.next_page_available),
        page.next_page_mode ?? null,
        page.quality ? JSON.stringify(page.quality) : null,
      );
    }
  });

  return {
    db_path: db.path,
    crawl_run_id: crawlRunId,
    inserted: stats.inserted,
    updated: stats.updated,
    unchanged: stats.unchanged,
  };
}
