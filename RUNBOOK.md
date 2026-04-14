# IndiaMart Perf Suite — Quick Runbook

A short guide on **what to run**, **in what order**, and **where to find things**.

---

## 🗂️ Where Things Live

| What | Location |
|------|----------|
| E2E runner script | `scripts/e2e.sh` |
| Baseline capture script | `scripts/capture-baselines.ts` |
| Docker stack helper | `scripts/docker-up.sh` |
| **Sitemap loader** | **`utils/sitemap-loader.ts`** |
| **Sitemap preview script** | **`scripts/sitemap-preview.ts`** |
| **PDF report script** | **`scripts/generate-pdf-report.ts`** |
| npm shortcuts | `package.json` → `scripts` block |
| Captured baselines | `baselines/{page-slug}/{desktop\|mobile}/` |
| Baseline index | `baselines/manifest.json` |
| Lighthouse raw reports | `raw-reports/{run-id}/` |
| **PDF & HTML reports** | **`reports/{run-id}/`** |
| Visual diff PNGs | `diffs/{run-id}/` |
| Playwright recordings | `recordings/{run-id}/` |
| Grafana dashboard | http://localhost:3001 (admin / admin) |
| **Dashboard UI** | **`dashboard/`** → http://localhost:4000 |

---

## 🚀 Run Sequence

### 1 — First-time setup (run once)

```bash
npm install
npx playwright install chromium
```

Apply the DB schema (requires Docker stack running):
```bash
bash scripts/docker-up.sh
psql "postgresql://perf_user:perf_pass@localhost:5432/perf_metrics" -f db/schema.sql
```

---

### 2 — Capture visual baselines (run once, or after a UI change)

> ⚠️ **Required before Phase 2 or Phase 3.** Visual QA needs these PNG references to detect regressions.

```bash
# First time — capture baselines for all pages (desktop + mobile)
npm run capture-baselines

# If baselines already exist and you want to refresh/overwrite them
npm run capture-baselines:force
```

Baselines are saved to → `baselines/{page-slug}/{desktop|mobile}/baseline_<timestamp>.png`
An index is written to → `baselines/manifest.json`

---

### 3 — Run Phase 1 (Web Vitals only)

Runs Lighthouse (median of 3) for all pages. Stores results in TimescaleDB.

```bash
npm run e2e
# or explicitly:
RUN_PHASE=1 bash scripts/e2e.sh
```

Run for a single page only:
```bash
RUN_PHASE=1 bash scripts/e2e.sh --page homepage
```

---

### 4 — Run Phase 2 (Vitals + Network Sim + Visual QA)

> ⚠️ **Baselines must exist** before running this phase (see Step 2).

```bash
npm run e2e:phase2
# or explicitly:
RUN_PHASE=2 bash scripts/e2e.sh
```

What runs additionally vs Phase 1:
- Network simulation across 4 CDP profiles (4G, FAST_3G, SLOW_3G, OFFLINE)
- Visual QA — pixel diffs against baselines → saved in `diffs/`
- Playwright screen recordings → saved in `recordings/`

---

### 5 — Run Phase 3 (Everything + AI Analysis + Jira)

> ⚠️ Requires `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` and Jira env vars in `.env`.

```bash
npm run e2e:phase3
# or explicitly:
RUN_PHASE=3 bash scripts/e2e.sh
```

Dry-run (no DB writes, no Slack/Jira):
```bash
npm run e2e:dry
# or explicitly:
RUN_PHASE=3 bash scripts/e2e.sh --dry-run
```

What runs additionally vs Phase 2:
- Third-party script audit (HAR-based)
- LLM root cause analysis (Claude or Gemini)
- Jira ticket creation for HIGH/CRITICAL regressions

---

## 🗺️ Sitemap-Driven Testing

Instead of the fixed curated page list in `config/pages.ts`, you can point the suite
at a live sitemap URL and let it automatically discover, sample, and test pages.

IndiaMart uses a **2-level sitemap index** structure:
```
https://www.indiamart.com/company/fcp-sitemap-ssl.xml  (index of 1,735 child sitemaps)
  └── fcp-smp-ssl1.xml  → thousands of supplier/product/category URLs
  └── fcp-smp-ssl2.xml  → ...
  └── ...
```

### Step 1 — Preview first (no browser, instant)

Always run the preview to see what will be tested before committing to a real run:

```bash
npm run sitemap:preview -- \
  --sitemap https://www.indiamart.com/company/fcp-sitemap-ssl.xml \
  --sample 10 \
  --max-sitemaps 20
```

This prints a breakdown table showing URL counts per page type, which URLs were
sampled, and an estimated runtime — without launching any browser.

### Step 2 — Run on a random sample (recommended)

Fetch 20 randomly-picked child sitemaps, pick 10 URLs per page type, run Phase 1:

```bash
RUN_PHASE=1 npm run test:perf -- \
  --sitemap https://www.indiamart.com/company/fcp-sitemap-ssl.xml \
  --sample 10 \
  --max-sitemaps 20
```

With 3 page types × 10 URLs × 3 Lighthouse runs ≈ **~23 minutes**.

Increase `--sample` or `--max-sitemaps` for broader coverage:
```bash
# 15 URLs per type, from 50 child sitemaps, 3 pages in parallel
RUN_PHASE=1 npm run test:perf -- \
  --sitemap https://www.indiamart.com/company/fcp-sitemap-ssl.xml \
  --sample 15 \
  --max-sitemaps 50 \
  --concurrency 3
```

### Step 3 — Run on ALL URLs (use with caution ⚠️)

> ⚠️ **Very slow.** 1,735 child sitemaps × thousands of URLs each.
> Use `--sample all` with a small `--max-sitemaps` to control scope.

```bash
# All URLs from 20 child sitemaps (no per-type sampling cap)
RUN_PHASE=1 npm run test:perf -- \
  --sitemap https://www.indiamart.com/company/fcp-sitemap-ssl.xml \
  --sample all \
  --max-sitemaps 20 \
  --concurrency 5

# Truly all URLs from all sitemaps (could take hours)
RUN_PHASE=1 npm run test:perf -- \
  --sitemap https://www.indiamart.com/company/fcp-sitemap-ssl.xml \
  --sample all \
  --max-sitemaps all \
  --concurrency 5
```

### Sitemap CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--sitemap <url\|file>` | — | Sitemap index URL or local XML file path |
| `--sample <N\|all>` | `15` | URLs to pick per page type (after shuffle) |
| `--max-sitemaps <N\|all>` | `20` | Child sitemaps to fetch from the index |
| `--concurrency <N>` | `1` | Pages to test in parallel |

> **Note:** `--sitemap` overrides `--page`. The curated `config/pages.ts` list
> is used only when `--sitemap` is not passed.

---

## 🧪 Unit Tests Only (no Lighthouse, no browser)

```bash
npm test
# or with type-check:
npm run smoke
```

---

## 📄 PDF Performance Report

Generate a polished PDF report from any Lighthouse run's JSON files.
Uses **Playwright** (already installed) to render — no extra dependencies.

Output saved to → `reports/{run-id}/performance-report.pdf`

```bash
# Generate PDF from the most recent run (auto-detected)
npm run report:pdf

# Generate PDF from a specific run
npm run report:pdf -- --run-id 2cfd5cd4-a3e5-4e73-9423-02cdb6cae424

# Save to a custom path
npm run report:pdf -- --run-id <uuid> --out ./my-report.pdf
```

**What the PDF contains:**
- Cover page with run ID, date, avg Performance score
- Summary stats: pages audited, avg score, LCP pass rate, CLS pass rate
- Per-page cards with:
  - Four category score gauges (Performance, Accessibility, Best Practices, SEO)
  - Full metrics table: LCP, CLS, INP, FCP, TTFB, TBT, Speed Index
  - Color-coded pass/fail badges vs Core Web Vitals thresholds
  - Median values across all Lighthouse runs for that page

> **Tip:** Also generates `performance-report.html` alongside the PDF so you
> can open it in a browser for a live, clickable version.

---

## 🖥️ Local Dashboard UI

A browser-based dashboard to **run any operation and view PDF reports** — no terminal needed.

### Start the dashboard

```bash
# Make sure node is on your PATH first (if using nvm):
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"

# Then start from the project root:
node dashboard/server.js
```

Open **http://localhost:4000** in your browser.

> **Tip:** Add `npm run dashboard` to your shell startup or run it in a dedicated terminal tab — it's lightweight and stays out of the way.

### What you can do from the UI

| Action | Equivalent CLI command |
|--------|------------------------|
| Run E2E Phase 1 / 2 / 3 | `npm run e2e` / `e2e:phase2` / `e2e:phase3` |
| Generate PDF Report | `npm run report:pdf` |
| Capture Baselines | `npm run capture-baselines` |
| Sitemap Preview | `npm run sitemap:preview` |
| Unit Tests | `npm test` |

### Tabs

- **Terminal** — live streaming output with colour rendering as the job runs
- **Reports** — lists every run ID from `raw-reports/` and `reports/`; shows JSON count, PDF, and HTML badges; one-click **View PDF** or **Generate PDF** per run
- **PDF Viewer** — renders the selected PDF inline inside the browser

### Stop a running job

Click **⏹ Stop Running Job** in the sidebar. This sends `SIGKILL` to the entire process group (npm → bash → tsx → chrome), so it stops immediately.

---

| Command | What it does |
|---------|-------------|
| `npm run capture-baselines` | Capture PNG baselines for all pages |
| `npm run capture-baselines:force` | Overwrite existing baselines |
| `npm run e2e` | Phase 1 — Web Vitals (curated pages) |
| `npm run e2e:phase2` | Phase 2 — Vitals + Network + Visual |
| `npm run e2e:phase3` | Phase 3 — Full suite + AI + Jira |
| `npm run e2e:dry` | Phase 3 dry-run (no side-effects) |
| `npm run sitemap:preview` | Preview sitemap sampling — no browser |
| `npm run report:pdf` | Generate PDF report from latest run |
| `node dashboard/server.js` | Start local Dashboard UI on port 4000 |
| `npm run docker:up` | Start TimescaleDB + Grafana containers |
| `npm run docker:down` | Stop containers |
| `npm test` | Unit tests (Vitest) |
| `npm run smoke` | TypeScript check + unit tests |

---

## 🔁 Recommended Full Sequence (fresh machine)

```bash
# 1. Install deps
npm install && npx playwright install chromium

# 2. Start Docker
npm run docker:up

# 3. Apply DB schema
psql "postgresql://perf_user:perf_pass@localhost:5432/perf_metrics" -f db/schema.sql

# 4. Capture baselines (needed for Phase 2+)
npm run capture-baselines

# 5. Run full suite
npm run e2e:phase3
```
