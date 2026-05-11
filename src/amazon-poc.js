import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { closeStorage, getKnownReviewKeys, openStorage, saveCrawlResult } from './storage.js';

const DEFAULT_OUTPUT_DIR = path.resolve('output');
const DEFAULT_SNAPSHOT_DIR = path.resolve('snapshots', 'amazon-jp');
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
    asin: '',
    url: '',
    maxPages: 3,
    headful: false,
    outputDir: DEFAULT_OUTPUT_DIR,
    snapshotDir: DEFAULT_SNAPSHOT_DIR,
    profileDir: '',
    delayMs: 3500,
    prepareSession: false,
    manualResolve: false,
    minimized: false,
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
    } else if (token === '--asin') {
      args.asin = next ?? '';
      i += 1;
    } else if (token === '--url') {
      args.url = next ?? '';
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
    } else if (token === '--profile-dir') {
      args.profileDir = path.resolve(next ?? '');
      i += 1;
    } else if (token === '--delay-ms') {
      args.delayMs = Number.parseInt(next ?? '', 10);
      i += 1;
    } else if (token === '--prepare-session') {
      args.prepareSession = true;
    } else if (token === '--manual-resolve') {
      args.manualResolve = true;
    } else if (token === '--minimized') {
      args.minimized = true;
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
  if (!Number.isFinite(args.delayMs) || args.delayMs < 0) args.delayMs = 3500;
  return args;
}

function printHelp() {
  console.log(`
Amazon Japan review PoC

Usage:
  npm run amazon -- --asin B0XXXXXXXX --max-pages 3
  npm run amazon -- --url "https://www.amazon.co.jp/dp/B0XXXXXXXX" --headful

Options:
  --asin          Amazon ASIN.
  --url           Amazon Japan product or review URL. ASIN is extracted from it.
  --max-pages     Max review pages to crawl. Default: 3.
  --headful       Show Chromium. Useful for CAPTCHA/manual inspection.
  --delay-ms      Delay between pages. Default: 3500.
  --output-dir    Output directory. Default: output.
  --snapshot-dir  HTML snapshot directory. Default: snapshots/amazon-jp.
  --profile-dir   Persistent browser profile directory. Useful with --headful.
  --prepare-session
                 Open a visible browser and wait for manual CAPTCHA/region/cookie setup.
  --manual-resolve
                 When blocked/login is detected, keep the browser open and retry after manual fix.
  --minimized    Start visible Chromium minimized when possible.
  --input-file   CSV/TXT file with ASINs or Amazon URLs for batch sample testing.
  --db           SQLite database path. Default: data/iceman.sqlite.
  --no-db        Do not write SQLite.
  --incremental  Stop when a recent-sorted page has no new reviews in SQLite.
`);
}

function extractAsin(input) {
  if (!input) return '';
  const trimmed = input.trim();
  if (/^[A-Z0-9]{10}$/i.test(trimmed)) return trimmed.toUpperCase();

  const patterns = [
    /\/dp\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/gp\/product\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /\/product-reviews\/([A-Z0-9]{10})(?:[/?]|$)/i,
    /[?&]asin=([A-Z0-9]{10})(?:&|$)/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return '';
}

function reviewPageUrl(asin, pageNumber) {
  const params = new URLSearchParams({
    ie: 'UTF8',
    'review.sortBy': 'recent',
    pageNumber: String(pageNumber),
    language: 'ja_JP',
  });
  return `https://www.amazon.co.jp/product-reviews/${asin}/?${params.toString()}`;
}

function productUrl(asin) {
  return `https://www.amazon.co.jp/dp/${asin}`;
}

function reviewKey(review) {
  return review.review_id || `${review.asin}:${review.review_date}:${review.reviewer_name}:${review.review_body}`;
}

async function ensureDirs(...dirs) {
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
}

async function readAsinInputs(filePath) {
  const text = await fs.readFile(filePath, 'utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => !/^asin\s*,?/i.test(line))
    .map((line) => {
      const [first, label = ''] = line.split(',').map((value) => value.trim());
      const asin = extractAsin(first);
      if (!asin) return null;
      return {
        asin,
        url: first.startsWith('http') ? first : '',
        label,
      };
    })
    .filter(Boolean);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replaceAll('"', '""')}"`;
}

async function writeBatchCsv(filePath, rows) {
  const headers = [
    'asin',
    'label',
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

async function writeCsv(filePath, rows) {
  const headers = [
    'platform',
    'asin',
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
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ];
  await fs.writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');
}

async function saveSnapshot(page, snapshotDir, asin, label) {
  const html = await page.content();
  const safeLabel = label.replaceAll(/[^a-z0-9_-]/gi, '_');
  const filePath = path.join(snapshotDir, `${asin}_${safeLabel}.html`);
  await fs.writeFile(filePath, html, 'utf8');
  return filePath;
}

function isResolvableState(state) {
  return state.type === 'blocked' || state.type === 'login';
}

async function waitForManualConfirmation(message) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message}\nType "retry" to continue or "abort" to stop: `);
    return answer.trim().toLowerCase();
  } finally {
    rl.close();
  }
}

async function detectPageState(page) {
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  const normalized = bodyText.replace(/\s+/g, ' ').trim();

  if (/captcha|robot|ロボット|画像に表示されている文字|入力してください/i.test(normalized)) {
    return { type: 'blocked', reason: 'CAPTCHA or robot-check page detected' };
  }

  if (/sign in|ログイン|サインイン/i.test(normalized) && /password|パスワード/i.test(normalized)) {
    return { type: 'login', reason: 'Login page detected' };
  }

  return { type: 'ok', reason: '' };
}

function parseRating(text) {
  if (!text) return null;
  const normalized = text.replace(',', '.');
  const match =
    normalized.match(/5つ星のうち\s*([0-5](?:\.[0-9])?)/) ||
    normalized.match(/([0-5](?:\.[0-9])?)\s*out of\s*5/i) ||
    normalized.match(/([0-5](?:\.[0-9])?)/);
  return match ? Number.parseFloat(match[1]) : null;
}

function cleanReviewTitle(text) {
  if (!text) return '';
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const title = lines.at(-1) ?? '';
  return title
    .replace(/^5つ星のうち\s*[0-5](?:[.,][0-9])?\s*/, '')
    .replace(/^[0-5](?:[.,][0-9])?\s*out of\s*5\s*stars?\s*/i, '')
    .trim();
}

async function extractProductTitle(page) {
  const selectors = [
    '[data-hook="cr-product-title"]',
    '#productTitle',
    'h1',
  ];

  for (const selector of selectors) {
    const text = await page.locator(selector).first().innerText({ timeout: 1500 }).catch(() => '');
    if (text.trim()) return text.replace(/\s+/g, ' ').trim();
  }
  return '';
}

async function extractReviews(page, asin, pageNo, productTitle) {
  return page.locator('[data-hook="review"]').evaluateAll((nodes, payload) => {
    const textOf = (root, selector) => {
      const node = root.querySelector(selector);
      return node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    };

    const hrefOf = (root, selector) => {
      const node = root.querySelector(selector);
      const href = node?.getAttribute('href') ?? '';
      if (!href) return '';
      return href.startsWith('http') ? href : `https://www.amazon.co.jp${href}`;
    };

    return nodes.map((node) => {
      const ratingText =
        textOf(node, '[data-hook="review-star-rating"]') ||
        textOf(node, '[data-hook="cmps-review-star-rating"]');
      const titleText = textOf(node, '[data-hook="review-title"]');
      const verifiedText = textOf(node, '[data-hook="avp-badge"]');
      const reviewId = node.getAttribute('id') || '';

      return {
        platform: 'amazon_jp',
        asin: payload.asin,
        product_title: payload.productTitle,
        product_url: `https://www.amazon.co.jp/dp/${payload.asin}`,
        review_id: reviewId,
        review_url:
          hrefOf(node, 'a[data-hook="review-title"]') ||
          (reviewId ? `https://www.amazon.co.jp/gp/customer-reviews/${reviewId}` : ''),
        rating_text: ratingText,
        review_title_raw: titleText,
        review_body: textOf(node, '[data-hook="review-body"]'),
        reviewer_name: textOf(node, '.a-profile-name'),
        review_date: textOf(node, '[data-hook="review-date"]'),
        variant: textOf(node, '[data-hook="format-strip"]'),
        verified_purchase: /購入|Verified Purchase/i.test(verifiedText),
        helpful_count: textOf(node, '[data-hook="helpful-vote-statement"]'),
        page_no: payload.pageNo,
        scraped_at: new Date().toISOString(),
      };
    });
  }, { asin, pageNo, productTitle });
}

function normalizeReview(raw) {
  return {
    ...raw,
    rating: parseRating(raw.rating_text),
    review_title: cleanReviewTitle(raw.review_title_raw),
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

function parseCount(text) {
  if (!text) return null;
  const match = text.replaceAll(',', '').match(/(\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

async function extractTotalRatingCount(page) {
  const text = await page.locator('[data-hook="total-review-count"]').first().innerText({ timeout: 1500 }).catch(() => '');
  return parseCount(text);
}

async function extractTextReviewCount(page) {
  const text = await page
    .locator('[data-hook="cr-filter-info-review-rating-count"]')
    .first()
    .innerText({ timeout: 1500 })
    .catch(() => '');
  return parseCount(text);
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

async function waitBetweenPages(delayMs) {
  if (delayMs <= 0) return;
  const jitter = Math.floor(Math.random() * 1200);
  await new Promise((resolve) => setTimeout(resolve, delayMs + jitter));
}

async function getNextPageAction(page) {
  const showMore = page.locator('[data-hook="show-more-button"]').first();
  if (await showMore.count().catch(() => 0)) {
    const visible = await showMore.isVisible().catch(() => false);
    if (visible) return { type: 'show-more', selector: '[data-hook="show-more-button"]' };
  }

  const nextLink = page.locator('li.a-last a, .a-pagination .a-last a').first();
  if (await nextLink.count().catch(() => 0)) {
    const href = await nextLink.getAttribute('href').catch(() => '');
    if (href) {
      return {
        type: 'link',
        url: href.startsWith('http') ? href : `https://www.amazon.co.jp${href}`,
      };
    }
  }

  return { type: 'none' };
}

async function advanceToNextReviewsPage(page, nextAction, visibleReviewCount) {
  if (nextAction.type === 'show-more') {
    await page.locator(nextAction.selector).first().scrollIntoViewIfNeeded().catch(() => {});
    await page.locator(nextAction.selector).first().click({ timeout: 15000 });
    await page.waitForFunction(
      (count) => document.querySelectorAll('[data-hook="review"]').length > count,
      visibleReviewCount,
      { timeout: 30000 },
    ).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    return;
  }

  if (nextAction.type === 'link') {
    await page.goto(nextAction.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }
}

async function manualRecover(page, run, args, asin, label, state) {
  if (!args.manualResolve || !args.headful || !args.profileDir || !isResolvableState(state)) {
    return state;
  }

  const followupSnapshot = await saveSnapshot(page, args.snapshotDir, asin, `${label}_${state.type}`);
  run.snapshots.push(followupSnapshot);
  if (args.minimized) await setBrowserWindowState(page, 'normal');

  const answer = await waitForManualConfirmation(
    [
      `Amazon page state: ${state.type}`,
      `Reason: ${state.reason}`,
      'The Chromium window has been opened for manual handling.',
      'Please finish CAPTCHA / region / cookie handling in that window.',
    ].join('\n'),
  );

  if (answer !== 'retry') {
    return { ...state, reason: `${state.reason} (manual flow aborted)` };
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  const recoveredState = await detectPageState(page);
  const recoveredSnapshot = await saveSnapshot(page, args.snapshotDir, asin, `${label}_after_manual_retry`);
  run.snapshots.push(recoveredSnapshot);
  return recoveredState;
}

async function openBrowserContext(args) {
  const browserArgs = args.minimized && args.headful ? ['--start-minimized'] : [];
  const contextOptions = {
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1365, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };

  const browser = args.profileDir ? null : await chromium.launch({
    headless: !args.headful,
    args: browserArgs,
  });
  const context = args.profileDir
    ? await chromium.launchPersistentContext(args.profileDir, {
      ...contextOptions,
      headless: !args.headful,
      args: browserArgs,
    })
    : await browser.newContext(contextOptions);
  const page = context.pages()[0] ?? await context.newPage();
  if (args.minimized && args.headful && !args.prepareSession) {
    await setBrowserWindowState(page, 'minimized');
  }
  return { browser, context, page };
}

async function setBrowserWindowState(page, windowState) {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.send('Browser.setWindowBounds', {
      windowId,
      bounds: { windowState },
    });
    await session.detach().catch(() => {});
    if (windowState === 'normal') await page.bringToFront().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

function validateManualModes(args) {
  if ((args.prepareSession || args.manualResolve) && !args.headful) {
    throw new Error('Manual browser flows require --headful.');
  }

  if ((args.prepareSession || args.manualResolve) && !args.profileDir) {
    throw new Error('Manual browser flows require --profile-dir so the session can be reused.');
  }
}

async function prepareSession(args) {
  validateManualModes(args);
  const asin = extractAsin(args.asin || args.url);
  const startUrl = asin ? productUrl(asin) : 'https://www.amazon.co.jp/';

  await ensureDirs(args.outputDir, args.snapshotDir, args.profileDir);

  const { browser, context, page } = await openBrowserContext(args);

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    const answer = await waitForManualConfirmation(
      [
        'Session preparation mode is active.',
        `Opened: ${startUrl}`,
        'Use the visible browser to handle CAPTCHA, region, language, cookies, or login prompts.',
      ].join('\n'),
    );

    const finalState = await detectPageState(page);
    const finalUrl = page.url();
    const snapshotAsin = asin || 'session';
    const snapshot = await saveSnapshot(page, args.snapshotDir, snapshotAsin, 'prepared_session');

    return {
      mode: 'prepare-session',
      status: answer === 'retry' ? finalState.type : 'aborted',
      start_url: startUrl,
      final_url: finalUrl,
      snapshot,
      profile_dir: args.profileDir,
      reason: answer === 'retry' ? finalState.reason : 'Session preparation aborted by user',
    };
  } finally {
    await context.close();
    if (browser) await browser.close();
  }
}

async function crawlAmazonReviews(args) {
  const asin = extractAsin(args.asin || args.url);
  if (!asin) {
    throw new Error('Missing ASIN. Provide --asin B0XXXXXXXX or --url https://www.amazon.co.jp/dp/B0XXXXXXXX');
  }

  validateManualModes(args);
  await ensureDirs(args.outputDir, args.snapshotDir);
  if (args.profileDir) await ensureDirs(args.profileDir);

  const { browser, context, page } = await openBrowserContext(args);

  const run = {
    platform: 'amazon_jp',
    asin,
    product_url: productUrl(asin),
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
  let productTitle = '';
  let totalRatingCount = null;
  let textReviewCount = null;

  try {
    await page.goto(productUrl(asin), { waitUntil: 'domcontentloaded', timeout: 60000 });
    run.snapshots.push(await saveSnapshot(page, args.snapshotDir, asin, 'product'));
    let productState = await detectPageState(page);
    productState = await manualRecover(page, run, args, asin, 'product', productState);
    if (productState.type !== 'ok') {
      run.status = productState.type;
      run.error = productState.reason;
      run.stop_reason = productState.reason;
      return { run, reviews };
    }

    productTitle = await extractProductTitle(page);

    await page.goto(reviewPageUrl(asin, 1), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    for (let pageNo = 1; pageNo <= args.maxPages; pageNo += 1) {
      const url = page.url();
      const snapshot = await saveSnapshot(page, args.snapshotDir, asin, `reviews_page_${pageNo}`);
      run.snapshots.push(snapshot);

      let state = await detectPageState(page);
      state = await manualRecover(page, run, args, asin, `reviews_page_${pageNo}`, state);
      if (state.type !== 'ok') {
        run.page_results.push({ page_no: pageNo, url, status: state.type, reason: state.reason, count: 0 });
        run.status = state.type;
        run.error = state.reason;
        break;
      }

      if (!productTitle) productTitle = await extractProductTitle(page);
      if (totalRatingCount == null) totalRatingCount = await extractTotalRatingCount(page);
      if (textReviewCount == null) textReviewCount = await extractTextReviewCount(page);

      const reviewContainerCount = await page.locator('[data-hook="review"]').count().catch(() => 0);
      const visibleReviews = (await extractReviews(page, asin, pageNo, productTitle)).map(normalizeReview);
      const pageReviews = visibleReviews.filter((review) => {
        const key = reviewKey(review);
        if (seenReviewKeys.has(key)) return false;
        seenReviewKeys.add(key);
        return true;
      });
      const pageQuality = summarizeReviews(pageReviews);
      reviews.push(...pageReviews);
      const nextAction = await getNextPageAction(page);
      run.page_results.push({
        page_no: pageNo,
        url,
        status: 'ok',
        reason: '',
        count: pageReviews.length,
        review_container_count: reviewContainerCount,
        visible_review_count: visibleReviews.length,
        total_rating_count: totalRatingCount,
        total_text_review_count: textReviewCount,
        next_page_available: nextAction.type !== 'none',
        next_page_mode: nextAction.type,
        quality: pageQuality,
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

      if (textReviewCount != null && reviews.length >= textReviewCount) {
        run.stop_reason = 'Reached total text review count';
        break;
      }

      if (pageNo === args.maxPages) {
        run.stop_reason = 'Reached max_pages';
        break;
      }

      if (nextAction.type === 'none') {
        run.stop_reason = 'No next page link found';
        break;
      }

      await waitBetweenPages(args.delayMs);
      await advanceToNextReviewsPage(page, nextAction, reviewContainerCount);
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
    if (browser) await browser.close();
  }
}

async function runSingle(args, label = '', db = null) {
  const asin = extractAsin(args.asin || args.url);
  const knownReviewKeys = db && args.incremental
    ? getKnownReviewKeys(db, 'amazon_jp', asin)
    : new Set();
  const crawlArgs = {
    ...args,
    knownReviewKeys,
  };
  const { run, reviews } = await crawlAmazonReviews(crawlArgs);
  const baseName = `amazon_jp_${run.asin}_${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
  const jsonPath = path.join(args.outputDir, `${baseName}.json`);
  const csvPath = path.join(args.outputDir, `${baseName}.csv`);
  const runPath = path.join(args.outputDir, `${baseName}.run.json`);

  await fs.writeFile(jsonPath, JSON.stringify(reviews, null, 2), 'utf8');
  await writeCsv(csvPath, reviews);
  await fs.writeFile(runPath, JSON.stringify(run, null, 2), 'utf8');
  const dbResult = db ? saveCrawlResult(db, { run, reviews, jsonPath, csvPath, runPath }) : null;

  return {
    status: run.status,
    asin: run.asin,
    label,
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
  const inputs = await readAsinInputs(args.inputFile);
  if (!inputs.length) {
    throw new Error(`No valid ASINs or Amazon URLs found in ${args.inputFile}`);
  }

  await ensureDirs(args.outputDir);
  const results = [];

  for (const item of inputs) {
    const itemArgs = {
      ...args,
      asin: item.asin,
      url: item.url,
    };
    const result = await runSingle(itemArgs, item.label, db);
    results.push(result);
    console.log(JSON.stringify(result, null, 2));
    if (args.delayMs > 0) await waitBetweenPages(args.delayMs);
  }

  const baseName = `amazon_jp_batch_${new Date().toISOString().replaceAll(/[:.]/g, '-')}`;
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

  if (args.prepareSession) {
    const result = await prepareSession(args);
    console.log(JSON.stringify(result, null, 2));
    if (result.status !== 'ok') process.exitCode = 2;
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
