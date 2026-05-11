import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeStorage, getKnownReviewKeys, openStorage, saveCrawlResult } from './storage.js';

const PLATFORM = 'rakuten';
const DEFAULT_OUTPUT_DIR = path.resolve('output');
const DEFAULT_SNAPSHOT_DIR = path.resolve('snapshots', 'rakuten');
const DEFAULT_DB_PATH = path.resolve('data', 'iceman.sqlite');
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
    url: '',
    item: '',
    shopId: '',
    itemId: '',
    maxPages: 3,
    headful: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    snapshotDir: DEFAULT_SNAPSHOT_DIR,
    delayMs: 2500,
    inputFile: '',
    dbPath: DEFAULT_DB_PATH,
    noDb: false,
    incremental: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = argv[i + 1];

    if (token === '--help' || token === '-h') {
      args.help = true;
    } else if (token === '--url') {
      args.url = next ?? '';
      i += 1;
    } else if (token === '--item') {
      args.item = next ?? '';
      i += 1;
    } else if (token === '--shop-id') {
      args.shopId = next ?? '';
      i += 1;
    } else if (token === '--item-id') {
      args.itemId = next ?? '';
      i += 1;
    } else if (token === '--max-pages') {
      args.maxPages = Number.parseInt(next ?? '', 10);
      i += 1;
    } else if (token === '--headful') {
      args.headful = true;
    } else if (token === '--output-dir') {
      args.outputDir = path.resolve(next ?? DEFAULT_OUTPUT_DIR);
      i += 1;
    } else if (token === '--snapshot-dir') {
      args.snapshotDir = path.resolve(next ?? DEFAULT_SNAPSHOT_DIR);
      i += 1;
    } else if (token === '--delay-ms') {
      args.delayMs = Number.parseInt(next ?? '', 10);
      i += 1;
    } else if (token === '--input-file') {
      args.inputFile = path.resolve(next ?? '');
      i += 1;
    } else if (token === '--db') {
      args.dbPath = path.resolve(next ?? DEFAULT_DB_PATH);
      i += 1;
    } else if (token === '--no-db') {
      args.noDb = true;
    } else if (token === '--incremental') {
      args.incremental = true;
    }
  }

  if (!Number.isFinite(args.maxPages) || args.maxPages < 1) args.maxPages = 1;
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) args.delayMs = 2500;
  return args;
}

function printHelp() {
  console.log(`
Rakuten Ichiba review PoC

Usage:
  npm run rakuten -- --url "https://review.rakuten.co.jp/item/1/395099_10000613/1.1/" --max-pages 3
  npm run rakuten -- --url "https://item.rakuten.co.jp/zone-style/2024icm/" --max-pages 3
  npm run rakuten -- --item 395099_10000613 --max-pages 3
  npm run rakuten -- --shop-id 395099 --item-id 10000613

Options:
  --url           Rakuten item URL or review URL.
  --item          Rakuten numeric item key, e.g. 395099_10000613.
  --shop-id       Numeric Rakuten shop id. Use with --item-id.
  --item-id       Numeric Rakuten item id. Use with --shop-id.
  --max-pages     Max review pages to crawl. Default: 3.
  --headful       Show Chromium.
  --delay-ms      Delay between pages. Default: 2500.
  --output-dir    Output directory. Default: output.
  --snapshot-dir  HTML snapshot directory. Default: snapshots/rakuten.
  --input-file    TXT/CSV file with Rakuten review URLs, item URLs, or 395099_10000613 item keys.
  --db            SQLite database path. Default: data/iceman.sqlite.
  --no-db         Do not write SQLite.
  --incremental   Stop when a page has no new reviews in SQLite.
`);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function ensureDirs(...dirs) {
  await Promise.all(dirs.filter(Boolean).map((dir) => fs.mkdir(dir, { recursive: true })));
}

function parseReviewTarget(input) {
  const text = String(input ?? '').trim();
  const reviewMatch = text.match(/review\.rakuten\.co\.jp\/item\/1\/(\d+)_(\d+)(?:\/|$)/i);
  if (reviewMatch) {
    return {
      shopId: reviewMatch[1],
      itemId: reviewMatch[2],
      productId: `${reviewMatch[1]}_${reviewMatch[2]}`,
      reviewUrl: reviewPageUrl(`${reviewMatch[1]}_${reviewMatch[2]}`, 1),
      productUrl: '',
    };
  }

  const itemMatch = text.match(/^(\d+)_(\d+)$/);
  if (itemMatch) {
    return {
      shopId: itemMatch[1],
      itemId: itemMatch[2],
      productId: `${itemMatch[1]}_${itemMatch[2]}`,
      reviewUrl: reviewPageUrl(`${itemMatch[1]}_${itemMatch[2]}`, 1),
      productUrl: '',
    };
  }

  return null;
}

function parseItemUrl(input) {
  const text = String(input ?? '').trim();
  const match = text.match(/item\.rakuten\.co\.jp\/([^/?#]+)\/([^/?#]+)/i);
  if (!match) return null;
  return {
    shopCode: decodeURIComponent(match[1]),
    itemCode: decodeURIComponent(match[2]),
    productUrl: text,
  };
}

function reviewPageUrl(productId, pageNo) {
  return `https://review.rakuten.co.jp/item/1/${productId}/${pageNo}.1/`;
}

function reviewKey(review) {
  return review.review_id || `${review.asin}:${review.review_date}:${review.reviewer_name}:${review.review_body}`;
}

function parseInitialStateFromHtml(html) {
  const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});/);
  if (!match) return null;
  return JSON.parse(match[1]);
}

async function extractState(page) {
  const state = await page.evaluate(() => globalThis.window?.__INITIAL_STATE__ ?? null).catch(() => null);
  if (state) return state;
  return parseInitialStateFromHtml(await page.content());
}

async function saveSnapshot(page, snapshotDir, productId, label) {
  const html = await page.content();
  const safeLabel = label.replaceAll(/[^a-z0-9_-]/gi, '_');
  const filePath = path.join(snapshotDir, `${productId}_${safeLabel}.html`);
  await fs.writeFile(filePath, html, 'utf8');
  return filePath;
}

async function waitBetweenPages(delayMs) {
  if (delayMs <= 0) return;
  const jitter = Math.floor(Math.random() * 900);
  await new Promise((resolve) => setTimeout(resolve, delayMs + jitter));
}

async function openBrowser(args) {
  const browser = await chromium.launch({ headless: !args.headful });
  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1365, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();
  return { browser, context, page };
}

async function resolveTargetFromProductPage(page, productUrl) {
  await page.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const href = await page
    .locator('a[href*="review.rakuten.co.jp/item/1/"]')
    .first()
    .getAttribute('href', { timeout: 5000 })
    .catch(() => '');
  const parsedHref = parseReviewTarget(href);
  if (parsedHref) return { ...parsedHref, productUrl: page.url() };

  const html = await page.content();
  const htmlMatch =
    html.match(/review\.rakuten\.co\.jp\/item\/1\/(\d+)_(\d+)/i) ||
    html.match(/data-shop-id=["'](\d+)["'][\s\S]{0,240}?data-item-id=["'](\d+)["']/i);
  if (!htmlMatch) {
    throw new Error('Could not find Rakuten review item id from product page. Use --item shopId_itemId or a review.rakuten.co.jp URL.');
  }

  return {
    shopId: htmlMatch[1],
    itemId: htmlMatch[2],
    productId: `${htmlMatch[1]}_${htmlMatch[2]}`,
    reviewUrl: reviewPageUrl(`${htmlMatch[1]}_${htmlMatch[2]}`, 1),
    productUrl: page.url(),
  };
}

async function resolveTarget(args, page) {
  if (args.shopId && args.itemId) {
    return {
      shopId: args.shopId,
      itemId: args.itemId,
      productId: `${args.shopId}_${args.itemId}`,
      reviewUrl: reviewPageUrl(`${args.shopId}_${args.itemId}`, 1),
      productUrl: args.url || '',
    };
  }

  const directTarget = parseReviewTarget(args.item || args.url);
  if (directTarget) return directTarget;

  const itemUrl = parseItemUrl(args.url);
  if (itemUrl) return resolveTargetFromProductPage(page, itemUrl.productUrl);

  throw new Error('Missing Rakuten target. Provide --url, --item 395099_10000613, or --shop-id/--item-id.');
}

function normalizeProductUrl(url) {
  if (!url) return '';
  return url.replace(/^http:\/\//i, 'https://');
}

function normalizeSex(value) {
  if (value === 'male') return '男性';
  if (value === 'female') return '女性';
  return '';
}

function toReview(raw, payload) {
  const age = raw.ageRange ? `${raw.ageRange}${raw.ageSuffix || ''}` : '';
  const reviewerInfo = [normalizeSex(raw.sex), age].filter(Boolean).join(' ');
  const reviewUrl = `${reviewPageUrl(payload.productId, payload.pageNo)}#${raw.key || raw.encryptedRevKey || raw.revSubkey || ''}`;

  return {
    platform: PLATFORM,
    asin: payload.productId,
    product_title: payload.productTitle,
    product_url: payload.productUrl,
    review_id: raw.key || raw.encryptedRevKey || raw.revSubkey || '',
    review_url: reviewUrl,
    rating: Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null,
    rating_text: raw.rating ? `${raw.rating}` : '',
    review_title: raw.title || '',
    review_title_raw: raw.title || '',
    review_body: raw.body || '',
    reviewer_name: raw.nickname || '',
    review_date: raw.postDate || '',
    variant: raw.skuInfo || '',
    verified_purchase: Boolean(raw.orderDate),
    helpful_count: raw.helpfulCount == null ? '' : String(raw.helpfulCount),
    page_no: payload.pageNo,
    scraped_at: new Date().toISOString(),
    reviewer_info: reviewerInfo,
    order_date: raw.orderDate || '',
    media_count: Number(raw.mediaCount ?? 0),
    raw_review: raw,
  };
}

function extractReviewsFromState(state, payload) {
  const keys = state?.reviews?.itemReviews?.keys ?? [];
  const data = state?.reviews?.data ?? {};
  const seoReviews = state?.seo?.itemReviewList ?? [];
  const byKey = new Map(seoReviews.map((review) => [review.key, review]));

  return keys
    .map((key) => data[key] || byKey.get(key))
    .filter(Boolean)
    .map((review) => toReview(review, payload));
}

function countMissingRequiredFields(reviews) {
  const missing = Object.fromEntries(REQUIRED_REVIEW_FIELDS.map((field) => [field, 0]));
  for (const review of reviews) {
    for (const field of REQUIRED_REVIEW_FIELDS) {
      const value = review[field];
      if (value == null || value === '') missing[field] += 1;
    }
  }
  return missing;
}

function summarizeReviews(reviews) {
  const missing_required_fields = countMissingRequiredFields(reviews);
  const missing_required_total = Object.values(missing_required_fields).reduce((sum, count) => sum + count, 0);
  const ratings = reviews.map((review) => review.rating).filter((rating) => Number.isFinite(rating));
  return {
    review_count: reviews.length,
    required_fields: REQUIRED_REVIEW_FIELDS,
    missing_required_fields,
    missing_required_total,
    rating_min: ratings.length ? Math.min(...ratings) : null,
    rating_max: ratings.length ? Math.max(...ratings) : null,
  };
}

function dedupeReviews(reviews) {
  const seen = new Set();
  const deduped = [];
  for (const review of reviews) {
    const key = reviewKey(review);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(review);
  }
  return deduped;
}

async function writeCsv(filePath, rows) {
  const headers = [
    'platform',
    'product_id',
    'product_title',
    'product_url',
    'review_id',
    'review_url',
    'rating',
    'review_title',
    'review_body',
    'reviewer_name',
    'review_date',
    'variant',
    'verified_purchase',
    'helpful_count',
    'page_no',
    'scraped_at',
  ];
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => {
      const value = header === 'product_id' ? row.asin : row[header];
      return csvEscape(value);
    }).join(',')),
  ];
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function writeBatchCsv(filePath, rows) {
  const headers = [
    'product_id',
    'input',
    'status',
    'reviews',
    'pages_ok',
    'pages_attempted',
    'stop_reason',
    'missing_required_fields',
    'json',
    'csv',
    'run',
    'db_inserted',
    'db_updated',
    'db_unchanged',
    'crawl_run_id',
    'error',
  ];
  const lines = [
    headers.join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ];
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function readInputs(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => !/^url\s*,?/i.test(line))
    .map((line) => line.split(',')[0].trim());
}

async function crawlRakutenReviews(args) {
  await ensureDirs(args.outputDir, args.snapshotDir);
  const { browser, context, page } = await openBrowser(args);
  const run = {
    platform: PLATFORM,
    asin: '',
    product_url: '',
    max_pages: args.maxPages,
    started_at: new Date().toISOString(),
    finished_at: '',
    status: 'running',
    error: '',
    snapshots: [],
    page_results: [],
    quality: null,
    stop_reason: '',
  };
  const reviews = [];
  const seenReviewKeys = new Set();
  const knownReviewKeys = args.knownReviewKeys ?? new Set();

  try {
    const target = await resolveTarget(args, page);
    run.asin = target.productId;
    run.product_url = normalizeProductUrl(target.productUrl);

    for (let pageNo = 1; pageNo <= args.maxPages; pageNo += 1) {
      const url = reviewPageUrl(target.productId, pageNo);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      run.snapshots.push(await saveSnapshot(page, args.snapshotDir, target.productId, `reviews_page_${pageNo}`));

      const state = await extractState(page);
      if (!state?.reviews) {
        run.page_results.push({ page_no: pageNo, url, status: 'error', reason: 'Rakuten review state not found', count: 0 });
        run.status = 'error';
        run.error = 'Rakuten review state not found';
        run.stop_reason = run.error;
        break;
      }

      const productTitle = state.itemInfo?.name || '';
      const productUrl = normalizeProductUrl(state.itemInfo?.url || target.productUrl || run.product_url);
      if (!run.product_url && productUrl) run.product_url = productUrl;
      const totalTextReviewCount =
        state.itemInfo?.reviewRatings?.totalCount ??
        state.reviews?.itemReviews?.count ??
        state.rat?.page?.item?.customParams?.nr_review ??
        null;
      const totalRatingCount = totalTextReviewCount;
      const visibleReviews = extractReviewsFromState(state, {
        productId: target.productId,
        productTitle,
        productUrl: run.product_url || productUrl,
        pageNo,
      });
      const pageReviews = visibleReviews.filter((review) => {
        const key = reviewKey(review);
        if (seenReviewKeys.has(key)) return false;
        seenReviewKeys.add(key);
        return true;
      });
      reviews.push(...pageReviews);
      run.page_results.push({
        page_no: pageNo,
        url,
        status: 'ok',
        reason: '',
        count: pageReviews.length,
        review_container_count: visibleReviews.length,
        visible_review_count: visibleReviews.length,
        total_rating_count: totalRatingCount,
        total_text_review_count: totalTextReviewCount,
        next_page_available: totalTextReviewCount == null ? pageReviews.length > 0 : reviews.length < totalTextReviewCount,
        next_page_mode: 'url-page-number',
        quality: summarizeReviews(pageReviews),
        new_stored_review_count: pageReviews.filter((review) => !knownReviewKeys.has(reviewKey(review))).length,
      });

      if (pageReviews.length === 0) {
        run.stop_reason = 'No reviews found on page';
        break;
      }

      if (
        args.incremental &&
        pageReviews.length > 0 &&
        pageReviews.every((review) => knownReviewKeys.has(reviewKey(review)))
      ) {
        run.stop_reason = 'Incremental stop: page contains no new stored reviews';
        break;
      }

      if (totalTextReviewCount != null && reviews.length >= totalTextReviewCount) {
        run.stop_reason = 'Reached total text review count';
        break;
      }

      if (pageNo === args.maxPages) {
        run.stop_reason = 'Reached max_pages';
        break;
      }

      await waitBetweenPages(args.delayMs);
    }

    if (run.status === 'running') run.status = 'ok';
    const dedupedReviews = dedupeReviews(reviews);
    run.quality = summarizeReviews(dedupedReviews);
    if (!run.stop_reason) run.stop_reason = 'Reached max_pages';
    return { run, reviews: dedupedReviews };
  } catch (error) {
    run.status = 'error';
    run.error = error instanceof Error ? error.message : String(error);
    run.stop_reason = run.error;
    const dedupedReviews = dedupeReviews(reviews);
    run.quality = summarizeReviews(dedupedReviews);
    return { run, reviews: dedupedReviews };
  } finally {
    run.finished_at = new Date().toISOString();
    await context.close();
    await browser.close();
  }
}

async function runSingle(args, inputValue = '', db = null) {
  const targetForKnownKeys = parseReviewTarget(args.item || args.url || inputValue || `${args.shopId}_${args.itemId}`);
  const productId = targetForKnownKeys?.productId || '';
  const knownReviewKeys = db && args.incremental && productId
    ? getKnownReviewKeys(db, PLATFORM, productId)
    : new Set();
  const { run, reviews } = await crawlRakutenReviews({ ...args, knownReviewKeys });
  const safeProductId = run.asin || productId || 'unknown';
  const baseName = `rakuten_${safeProductId}_${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
  const jsonPath = path.join(args.outputDir, `${baseName}.json`);
  const csvPath = path.join(args.outputDir, `${baseName}.csv`);
  const runPath = path.join(args.outputDir, `${baseName}.run.json`);

  await fs.writeFile(jsonPath, JSON.stringify(reviews, null, 2), 'utf8');
  await writeCsv(csvPath, reviews);
  await fs.writeFile(runPath, JSON.stringify(run, null, 2), 'utf8');
  const dbResult = db ? saveCrawlResult(db, { run, reviews, jsonPath, csvPath, runPath }) : null;

  return {
    status: run.status,
    product_id: run.asin,
    input: inputValue || args.url || args.item || `${args.shopId}_${args.itemId}`,
    reviews: reviews.length,
    pages_ok: run.page_results.filter((pageResult) => pageResult.status === 'ok').length,
    pages_attempted: run.page_results.length,
    stop_reason: run.stop_reason,
    missing_required_fields: run.quality?.missing_required_total ?? '',
    json: jsonPath,
    csv: csvPath,
    run: runPath,
    db: dbResult?.db_path ?? '',
    db_inserted: dbResult?.inserted ?? '',
    db_updated: dbResult?.updated ?? '',
    db_unchanged: dbResult?.unchanged ?? '',
    crawl_run_id: dbResult?.crawl_run_id ?? '',
    error: run.error,
  };
}

async function runBatch(args, db = null) {
  const inputs = await readInputs(args.inputFile);
  if (!inputs.length) throw new Error(`No valid Rakuten URLs or item ids found in ${args.inputFile}`);

  const results = [];
  for (const input of inputs) {
    const result = await runSingle({ ...args, url: input, item: input }, input, db);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
    if (args.delayMs > 0) await waitBetweenPages(args.delayMs);
  }

  const baseName = `rakuten_batch_${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
  const jsonPath = path.join(args.outputDir, `${baseName}.json`);
  const csvPath = path.join(args.outputDir, `${baseName}.csv`);
  await fs.writeFile(jsonPath, JSON.stringify(results, null, 2), 'utf8');
  await writeBatchCsv(csvPath, results);
  return { results, jsonPath, csvPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const db = args.noDb ? null : openStorage(args.dbPath);
  try {
    if (args.inputFile) {
      const { results, jsonPath, csvPath } = await runBatch(args, db);
      const failed = results.filter((result) => result.status !== 'ok');
      console.log(JSON.stringify({
        status: failed.length ? 'partial' : 'ok',
        total: results.length,
        failed: failed.length,
        json: jsonPath,
        csv: csvPath,
        db: db?.path ?? '',
      }, null, 2));
      if (failed.length) process.exitCode = 2;
      return;
    }

    const result = await runSingle(args, '', db);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'ok') process.exitCode = 2;
  } finally {
    closeStorage(db);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
