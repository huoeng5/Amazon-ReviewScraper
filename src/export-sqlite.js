import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_DB_PATH = path.resolve('data', 'iceman.sqlite');
const DEFAULT_EXPORT_DIR = path.resolve('exports');
const REQUIRED_REVIEW_FIELDS = [
  'review_id',
  'review_url',
  'rating',
  'review_title',
  'review_body',
  'reviewer_name',
  'review_date',
];

function parseArgs(argv) {
  const args = {
    dbPath: DEFAULT_DB_PATH,
    exportDir: DEFAULT_EXPORT_DIR,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--db') {
      args.dbPath = path.resolve(next ?? DEFAULT_DB_PATH);
      i += 1;
    } else if (token === '--export-dir') {
      args.exportDir = path.resolve(next ?? DEFAULT_EXPORT_DIR);
      i += 1;
    }
  }

  return args;
}

function printHelp() {
  console.log(`
SQLite export and acceptance report

Usage:
  npm run export
  npm run export -- --db data/iceman.sqlite --export-dir exports

Outputs:
  exports/products.csv
  exports/reviews.csv
  exports/crawl_runs.csv
  exports/acceptance_report.json
`);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeCsv(filePath, rows) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ];
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

function countRows(db, tableName) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count;
}

function missingFieldSummary(db) {
  const rows = db.prepare(`
    SELECT
      ${REQUIRED_REVIEW_FIELDS.map((field) => `SUM(CASE WHEN ${field} IS NULL OR ${field} = '' THEN 1 ELSE 0 END) AS ${field}`).join(',\n      ')}
    FROM reviews
  `).get();

  return Object.fromEntries(REQUIRED_REVIEW_FIELDS.map((field) => [field, rows?.[field] ?? 0]));
}

function acceptanceReport(db, files) {
  const productSummaries = db.prepare(`
    SELECT
      p.platform,
      p.product_id,
      p.product_title,
      p.total_rating_count,
      p.total_text_review_count,
      COUNT(r.review_key) AS stored_review_count,
      MIN(r.rating) AS rating_min,
      MAX(r.rating) AS rating_max,
      p.first_seen_at,
      p.last_seen_at
    FROM products p
    LEFT JOIN reviews r
      ON r.platform = p.platform AND r.product_id = p.product_id
    GROUP BY p.platform, p.product_id
    ORDER BY p.platform, p.product_id
  `).all();

  const latestRuns = db.prepare(`
    SELECT
      id,
      platform,
      product_id,
      status,
      review_count,
      inserted_count,
      updated_count,
      unchanged_count,
      stop_reason,
      error,
      started_at,
      finished_at
    FROM crawl_runs
    ORDER BY id DESC
    LIMIT 10
  `).all();

  const missingFields = missingFieldSummary(db);
  const missingTotal = Object.values(missingFields).reduce((sum, count) => sum + count, 0);

  return {
    generated_at: new Date().toISOString(),
    database: files.dbPath,
    outputs: files,
    counts: {
      products: countRows(db, 'products'),
      reviews: countRows(db, 'reviews'),
      crawl_runs: countRows(db, 'crawl_runs'),
      crawl_pages: countRows(db, 'crawl_pages'),
    },
    review_quality: {
      required_fields: REQUIRED_REVIEW_FIELDS,
      missing_fields: missingFields,
      missing_total: missingTotal,
    },
    product_summaries: productSummaries,
    latest_runs: latestRuns,
  };
}

async function exportSqlite(args) {
  await fs.mkdir(args.exportDir, { recursive: true });
  const db = new DatabaseSync(args.dbPath);

  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA journal_mode = WAL');
    const products = db.prepare(`
      SELECT
        platform,
        product_id,
        product_title,
        product_url,
        total_rating_count,
        total_text_review_count,
        first_seen_at,
        last_seen_at
      FROM products
      ORDER BY platform, product_id
    `).all();

    const reviews = db.prepare(`
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
        first_seen_at,
        last_seen_at
      FROM reviews
      ORDER BY platform, product_id, review_date DESC, review_id
    `).all();

    const crawlRuns = db.prepare(`
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
    `).all();

    const files = {
      dbPath: args.dbPath,
      productsCsv: path.join(args.exportDir, 'products.csv'),
      reviewsCsv: path.join(args.exportDir, 'reviews.csv'),
      crawlRunsCsv: path.join(args.exportDir, 'crawl_runs.csv'),
      acceptanceReport: path.join(args.exportDir, 'acceptance_report.json'),
    };

    await writeCsv(files.productsCsv, products);
    await writeCsv(files.reviewsCsv, reviews);
    await writeCsv(files.crawlRunsCsv, crawlRuns);
    await fs.writeFile(files.acceptanceReport, JSON.stringify(acceptanceReport(db, files), null, 2), 'utf8');

    return {
      status: 'ok',
      products: products.length,
      reviews: reviews.length,
      crawl_runs: crawlRuns.length,
      ...files,
    };
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const result = await exportSqlite(args);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
