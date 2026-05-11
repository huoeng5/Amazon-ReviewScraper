export type DesktopLogLevel = 'info' | 'warn' | 'error';

export type DesktopLogPayload = {
  level: DesktopLogLevel;
  time?: string;
  message: string;
};

export type DesktopProduct = {
  platform: string;
  product_id: string;
  product_title: string | null;
  product_url: string | null;
  total_rating_count: number | null;
  total_text_review_count: number | null;
  first_seen_at: string;
  last_seen_at: string;
  stored_review_count: number;
  latest_run_id: number | null;
  latest_status: string | null;
  latest_started_at: string | null;
  latest_finished_at: string | null;
  latest_review_count: number | null;
  latest_inserted_count: number | null;
  latest_updated_count: number | null;
  latest_unchanged_count: number | null;
  latest_stop_reason: string | null;
  latest_error: string | null;
};

export type DesktopReview = {
  platform: string;
  product_id: string;
  review_key: string;
  review_id: string | null;
  review_url: string | null;
  rating: number | null;
  rating_text: string | null;
  review_title: string | null;
  review_body: string | null;
  reviewer_name: string | null;
  review_date: string | null;
  variant: string | null;
  verified_purchase: number | null;
  helpful_count: string | null;
  page_no: number | null;
  scraped_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

export type DesktopMetrics = {
  products: number;
  reviews: number;
  crawl_runs: number;
  crawl_pages: number;
  crawl_jobs: number;
  missing_required_total: number;
};

export type DesktopJobStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' | 'deleted';

export type DesktopJob = {
  id: number;
  platform: string;
  input: string;
  product_id: string;
  status: DesktopJobStatus;
  max_pages: number;
  headful: number;
  incremental: number;
  retry_count: number;
  last_crawl_run_id: number | null;
  job_review_count: number;
  job_inserted_count: number;
  job_updated_count: number;
  job_unchanged_count: number;
  job_stop_reason: string | null;
  job_error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  product_title: string | null;
  product_url: string | null;
  total_rating_count: number | null;
  total_text_review_count: number | null;
  stored_review_count: number;
  latest_run_id: number | null;
  latest_status: string | null;
  latest_started_at: string | null;
  latest_finished_at: string | null;
  latest_review_count: number | null;
  latest_inserted_count: number | null;
  latest_updated_count: number | null;
  latest_unchanged_count: number | null;
  latest_stop_reason: string | null;
  latest_error: string | null;
};

export type DesktopDataPayload = {
  status: string;
  dbPath: string;
  metrics: DesktopMetrics;
  missing_required_fields: Record<string, number>;
  jobs: DesktopJob[];
  products: DesktopProduct[];
  reviews: DesktopReview[];
  latest_runs: unknown[];
};

export type CrawlStartOptions = {
  input: string;
  maxPages?: number;
  headful?: boolean;
  incremental?: boolean;
};

export type IcemanApi = {
  data: {
    load: (filters?: { productId?: string; limit?: number }) => Promise<DesktopDataPayload>;
  };
  crawl: {
    start: (options: CrawlStartOptions) => Promise<{ status: string; asin?: string; message?: string; pid?: number }>;
    stop: () => Promise<{ status: string }>;
    manualRetry: () => Promise<{ status: string }>;
    manualAbort: () => Promise<{ status: string }>;
    onLog: (callback: (payload: DesktopLogPayload) => void) => () => void;
    onDone: (callback: (payload: { asin: string; result: unknown }) => void) => () => void;
    onError: (callback: (payload: { message: string }) => void) => () => void;
  };
  jobs: {
    add: (options: Partial<CrawlStartOptions> & { inputText?: string; start?: boolean }) => Promise<Record<string, unknown>>;
    start: () => Promise<Record<string, unknown>>;
    pause: () => Promise<Record<string, unknown>>;
    resume: () => Promise<Record<string, unknown>>;
    retry: (jobId: number) => Promise<Record<string, unknown>>;
    retryFailed: () => Promise<Record<string, unknown>>;
    delete: (jobId: number) => Promise<Record<string, unknown>>;
    clear: () => Promise<Record<string, unknown>>;
    onChanged: (callback: (payload: Record<string, unknown>) => void) => () => void;
  };
  app: {
    resetAll: () => Promise<Record<string, unknown>>;
    showMessage: (options: { type?: 'info' | 'warning' | 'error'; title?: string; message: string; detail?: string }) => Promise<Record<string, unknown>>;
  };
  export: {
    run: (options?: { productId?: string; scope?: 'product' | 'all'; showSuccessDialog?: boolean }) => Promise<Record<string, unknown>>;
  };
  shell: {
    openPath: (targetPath: string) => Promise<string>;
  };
};

declare global {
  interface Window {
    iceman?: IcemanApi;
  }
}
