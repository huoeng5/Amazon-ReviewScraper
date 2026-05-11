import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeStorage, getKnownReviewKeys, openStorage, saveCrawlResult } from './storage.js';

const PLATFORM = 'yahoo_shopping';
const DEFAULT_OUTPUT_DIR = path.resolve('output');
const DEFAULT_SNAPSHOT_DIR = path.resolve('snapshots', 'yahoo-shopping');
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
    storeId: '',
    pageKey: '',
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
    } else if (token === '--store-id') {
      args.storeId = next ?? '';
      i += 1;
    } else if (token === '--page-key') {
      args.pageKey = next ?? '';
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
Yahoo! Shopping review PoC

Usage:
  npm run yahoo -- --url "https://store.shopping.yahoo.co.jp/pirates-shop/y-prox3-rich.html" --max-pages 3
  npm run yahoo -- --url "https://shopping.yahoo.co.jp/review/item/list?store_id=pirates-shop&page_key=y-prox3-rich"
  npm run yahoo -- --item pirates-shop_y-prox3-rich
  npm run yahoo -- --store-id pirates-shop --page-key y-prox3-rich

Options:
  --url           Yahoo! Shopping item URL or review list URL.
  --item          Product key, e.g. pirates-shop_y-prox3-rich.
  --store-id      Store id. Use with --page-key.
  --page-key      Item page key. Use with --store-id.
  --max-pages     Max review pages to crawl. Default: 3.
  --headful       Show Chromium.
  --delay-ms      Delay between pages. Default: 2500.
  --output-dir    Output directory. Default: output.
  --snapshot-dir  HTML snapshot directory. Default: snapshots/yahoo-shopping.
  --input-file    TXT/CSV file with Yahoo URLs or product keys.
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

function productIdOf(storeId, pageKey) {
  return `${storeId}_${pageKey}`;
}

function parseYahooTarget(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  const direct = text.match(/^([a-z0-9-]+)_(.+)$/i);
  if (direct) {
    return {
      storeId: direct[1],
      pageKey: direct[2],
      productId: productIdOf(direct[1], direct[2]),
      productUrl: `https://store.shopping.yahoo.co.jp/${direct[1]}/${direct[2]}.html`,
      reviewUrl: reviewListUrl(direct[1], direct[2], 0),
    };
  }

  try {
    const url = new URL(text);
    const reviewStoreId = url.searchParams.get('store_id');
    const reviewPageKey = url.searchParams.get('page_key');
    if (reviewStoreId && reviewPageKey && /shopping\.yahoo\.co\.jp$/i.test(url.hostname)) {
      return {
        storeId: reviewStoreId,
        pageKey: reviewPageKey,
        productId: productIdOf(reviewStoreId, reviewPageKey),
        productUrl: `https://store.shopping.yahoo.co.jp/${reviewStoreId}/${reviewPageKey}.html`,
        reviewUrl: reviewListUrl(reviewStoreId, reviewPageKey, 0),
      };
    }

    const itemMatch = url.hostname === 'store.shopping.yahoo.co.jp'
      ? url.pathname.match(/^\/([^/]+)\/([^/?#]+)\.html$/i)
      : null;
    if (itemMatch) {
      const storeId = decodeURIComponent(itemMatch[1]);
      const pageKey = decodeURIComponent(itemMatch[2]);
      return {
        storeId,
        pageKey,
        productId: productIdOf(storeId, pageKey),
        productUrl: text,
        reviewUrl: reviewListUrl(storeId, pageKey, 0),
      };
    }
  } catch {
    return null;
  }

  return null;
}

function reviewListUrl(storeId, pageKey, offset = 0) {
  const params = new URLSearchParams({
    store_id: storeId,
    page_key: pageKey,
  });
  if (offset > 0) params.set('offset', String(offset));
  return `https://shopping.yahoo.co.jp/review/item/list?${params.toString()}`;
}

function reviewKey(review) {
  return review.review_id || `${review.asin}:${review.review_date}:${review.reviewer_name}:${review.review_body}`;
}

function formatYahooDate(value) {
  if (!value) return '';
  if (Number.isFinite(Number(value))) {
    const date = new Date(Number(value));
    if (!Number.isNaN(date.getTime())) {
      return date.toLocaleDateString('ja-JP', {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        timeZone: 'Asia/Tokyo',
      });
    }
  }
  return String(value);
}

function variantFromSubCodeOptions(options = []) {
  return options
    .map((option) => [option.name, option.value].filter(Boolean).join('/'))
    .filter(Boolean)
    .join('、');
}

function parseNextData(text) {
  if (!text) return null;
  return JSON.parse(text);
}

async function extractNextData(page) {
  const text = await page.locator('#__NEXT_DATA__').textContent({ timeout: 10000 }).catch(() => '');
  return parseNextData(text);
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

function productFromPageProps(pageProps, target) {
  const item = pageProps.lookupItemEntity?.item || pageProps.item || {};
  const reviewItem = pageProps.reviewEntity?.itemReview?.item || {};
  const storeId = item.storeId || reviewItem.sellerId || target.storeId;
  const pageKey = item.pageKey || item.code || reviewItem.srId || target.pageKey;
  return {
    storeId,
    pageKey,
    productId: productIdOf(storeId, pageKey),
    productTitle: item.name || '',
    productUrl: `https://store.shopping.yahoo.co.jp/${storeId}/${pageKey}.html`,
    catalogId: item.catalogId || '',
  };
}

function primaryReviewBucket(pageProps) {
  const candidates = [
    { source: 'itemReview', bucket: pageProps.reviewEntity?.itemReview },
    { source: 'catalogReview', bucket: pageProps.reviewEntity?.catalogReview },
    pageProps.review?.itemReviews ? {
      source: 'legacyReview',
      bucket: {
        reviews: pageProps.review.itemReviews,
        reviewSummary: pageProps.review.reviewSummary,
        filteredCount: pageProps.review.reviewSummary?.count,
        nextOffset: pageProps.review.nextOffset,
      },
    } : null,
    { source: 'pickUpItemReview', bucket: pageProps.pickUpItemReviewEntity?.itemReview },
  ].filter((candidate) => candidate?.bucket);

  return candidates.find((candidate) => Array.isArray(candidate.bucket.reviews) && candidate.bucket.reviews.length > 0)
    || candidates.find((candidate) => Array.isArray(candidate.bucket.reviews))
    || null;
}

function reviewsFromBucket(bucketRecord, product, pageNo, offset = 0) {
  const reviews = bucketRecord?.bucket?.reviews || [];
  return reviews.map((raw) => ({
    platform: PLATFORM,
    asin: product.productId,
    product_title: product.productTitle || raw.itemName || '',
    product_url: product.productUrl,
    review_id: raw.id || '',
    review_url: `${reviewListUrl(product.storeId, product.pageKey, offset)}#${raw.id || ''}`,
    rating: Number.isFinite(Number(raw.rating)) ? Number(raw.rating) : null,
    rating_text: raw.rating == null ? '' : String(raw.rating),
    review_title: raw.title || '',
    review_title_raw: raw.title || '',
    review_body: raw.body || '',
    reviewer_name: raw.maskYid || '',
    review_date: formatYahooDate(raw.postedTime || raw.postedDate),
    variant: variantFromSubCodeOptions(raw.subCodeOptions),
    verified_purchase: true,
    helpful_count: raw.referenceCount == null ? '' : String(raw.referenceCount),
    page_no: pageNo,
    scraped_at: new Date().toISOString(),
    media_count: Number(raw.images?.length ?? 0) + Number(raw.videos?.length ?? 0),
    raw_review: raw,
  }));
}

function summaryFromPageProps(pageProps) {
  return summaryFromBucket(primaryReviewBucket(pageProps));
}

function summaryFromBucket(bucketRecord) {
  const bucket = bucketRecord?.bucket;
  const summary = bucket?.reviewSummary || {};
  return {
    totalTextReviewCount: summary.count ?? bucket?.filteredCount ?? null,
    average: summary.average ?? null,
    nextOffset: bucket?.nextOffset ?? null,
  };
}

async function fetchNextReviewBucket(page, pageProps, product, source, offset) {
  if (!offset || !['catalogReview', 'itemReview'].includes(source)) return null;

  const endpoint = source === 'catalogReview'
    ? '/hreviewapi/catalog-review/get'
    : '/hreviewapi/item-review/get';
  const body = source === 'catalogReview'
    ? {
      catalogId: product.catalogId,
      ysrId: product.productId,
      sortType: 'lengthDesc',
      offset,
      limit: 10,
      sellerTypes: '0,1,2',
      token: pageProps.token,
    }
    : {
      storeId: product.storeId,
      pageKey: product.pageKey,
      sortType: 'lengthDesc',
      offset,
      limit: 10,
      token: pageProps.token,
    };

  const response = await page.evaluate(async ({ endpoint: apiEndpoint, body: requestBody }) => {
    const res = await fetch(apiEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
    return {
      ok: res.ok,
      status: res.status,
      data: await res.json().catch(() => null),
    };
  }, { endpoint, body });

  if (!response.ok || response.data?.error) {
    return {
      source,
      error: response.data?.error || `Yahoo review API failed: ${response.status}`,
      bucket: null,
    };
  }

  const bucket = source === 'catalogReview'
    ? response.data?.catalogReview
    : response.data?.itemReview;
  return { source, bucket };
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

async function crawlYahooReviews(args) {
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
    const target = args.storeId && args.pageKey
      ? parseYahooTarget(productIdOf(args.storeId, args.pageKey))
      : parseYahooTarget(args.item || args.url);
    if (!target) throw new Error('Missing Yahoo target. Provide --url, --item store_pageKey, or --store-id/--page-key.');

    run.asin = target.productId;
    run.product_url = target.productUrl;

    let totalTextReviewCount = null;
    let nextOffset = 0;
    let pageProps = null;
    let product = null;
    let bucketRecord = null;
    for (let pageNo = 1; pageNo <= args.maxPages; pageNo += 1) {
      const offset = pageNo === 1 ? 0 : nextOffset;
      const url = pageNo === 1
        ? reviewListUrl(target.storeId, target.pageKey, 0)
        : `${reviewListUrl(product.storeId, product.pageKey, 0)}#api-offset-${offset}`;

      if (pageNo === 1) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        run.snapshots.push(await saveSnapshot(page, args.snapshotDir, target.productId, `reviews_page_${pageNo}`));

        const nextData = await extractNextData(page);
        pageProps = nextData?.props?.pageProps;
        if (!pageProps) {
          run.page_results.push({ page_no: pageNo, url, status: 'error', reason: 'Yahoo Next.js page data not found', count: 0 });
          run.status = 'error';
          run.error = 'Yahoo Next.js page data not found';
          run.stop_reason = run.error;
          break;
        }

        product = productFromPageProps(pageProps, target);
        bucketRecord = primaryReviewBucket(pageProps);
      } else {
        bucketRecord = await fetchNextReviewBucket(page, pageProps, product, bucketRecord?.source, offset);
        if (bucketRecord?.error) {
          run.page_results.push({ page_no: pageNo, url, status: 'error', reason: bucketRecord.error, count: 0 });
          run.stop_reason = bucketRecord.error;
          break;
        }
      }

      run.asin = product.productId;
      run.product_url = product.productUrl;
      const summary = summaryFromBucket(bucketRecord);
      totalTextReviewCount = totalTextReviewCount ?? summary.totalTextReviewCount;
      nextOffset = summary.nextOffset ?? 0;

      const visibleReviews = reviewsFromBucket(bucketRecord, product, pageNo, offset);
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
        total_rating_count: totalTextReviewCount,
        total_text_review_count: totalTextReviewCount,
        next_page_available: Boolean(nextOffset) && (totalTextReviewCount == null || reviews.length < totalTextReviewCount),
        next_page_mode: 'offset',
        quality: summarizeReviews(pageReviews),
        new_stored_review_count: pageReviews.filter((review) => !knownReviewKeys.has(reviewKey(review))).length,
      });

      if (pageReviews.length === 0) {
        run.stop_reason = visibleReviews.length > 0 ? 'No new reviews found on page' : 'No reviews found on page';
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

      if (!nextOffset || nextOffset <= offset) {
        run.stop_reason = 'No next offset found';
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
  const targetForKnownKeys = parseYahooTarget(args.item || args.url || inputValue || productIdOf(args.storeId, args.pageKey));
  const productId = targetForKnownKeys?.productId || '';
  const knownReviewKeys = db && args.incremental && productId
    ? getKnownReviewKeys(db, PLATFORM, productId)
    : new Set();
  const { run, reviews } = await crawlYahooReviews({ ...args, knownReviewKeys });
  const safeProductId = run.asin || productId || 'unknown';
  const baseName = `yahoo_shopping_${safeProductId}_${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
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
    input: inputValue || args.url || args.item || productIdOf(args.storeId, args.pageKey),
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
  if (!inputs.length) throw new Error(`No valid Yahoo URLs or item ids found in ${args.inputFile}`);

  const results = [];
  for (const input of inputs) {
    const result = await runSingle({ ...args, url: input, item: input }, input, db);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
    if (args.delayMs > 0) await waitBetweenPages(args.delayMs);
  }

  const baseName = `yahoo_shopping_batch_${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
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
