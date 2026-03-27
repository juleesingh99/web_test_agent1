# IndiaMart performance test suite — changes, runbook, and analysis

This document summarizes what was added to the repository, how to run the tooling, and how to interpret and analyze results.

---

## 1. What changed (high level)

### Rules and prompts (`.cursor/rules/`)

- **`test-agent-rules.mdc`** — Aligned with the implemented stack: **Node.js 20+** and a **TypeScript orchestrator** (`agents/orchestrator.ts`), not a Python runner. Clarified that **TimescaleDB** is a PostgreSQL extension (enabled in SQL) while the app uses **`pg`**. Clarified parallel fan-out with **`Promise.allSettled`**. Added an explicit **10KB cap** note for Claude payloads (truncation is implemented in the analysis agent). Optional Python section is documented as not used by the default orchestrator.
- **`PROMPT.mdc`** — Added frontmatter so **`alwaysApply: false`** (copy-paste prompts only). **P1-01** dependency list was corrected: no fictional `timescaledb` npm package; **`chrome-launcher`** and verified packages listed.

### Application code (repository root)

| Area | What was added |
|------|------------------|
| **Config** | `config/pages.ts` (zod-validated page list), `config/thresholds.ts`, `config/network-profiles.ts` (four CDP profiles only). |
| **Database** | `db/schema.sql` — TimescaleDB extension, `runs`, `vitals_measurements`, `script_inventory` hypertables, indexes, retention, `daily_vitals_summary` continuous aggregate. `db/pool.ts`, `db/queries.ts` (inserts, baselines, deltas, **`detectRegression`**). |
| **Agents** | `agents/web-vitals-agent.ts` — programmatic Lighthouse (median of 3), raw JSON under `raw-reports/`. `agents/network-sim-agent.ts` — four CDP profiles in parallel using raw CDP (no Playwright overlap). `agents/visual-qa-agent.ts` — layout diffs (pixelmatch), jank heuristic, optional flicker note for ffmpeg. `agents/script-audit-agent.ts` — HAR-based third-party script inventory. `agents/analysis-agent.ts` — Claude or Gemini + zod JSON schema, git diff stat, payload cap. `agents/orchestrator.ts` — phases, `--dry-run`, `--page`, DB/Slack/Jira wiring. |
| **Reporters** | `reporters/slack-reporter.ts` (Block Kit, retries), `reporters/jira-reporter.ts` (REST v3). |
| **Utils** | `utils/logger.ts` (Winston), `utils/load-env.ts`, `utils/lighthouse-helpers.ts` (shared Lighthouse config + median runs). |
| **Scripts** | `scripts/capture-baselines.ts` — desktop/mobile baselines, `--force`, `baselines/manifest.json`. |
| **CI** | `.github/workflows/perf-test.yml` — Node 20, Playwright Chromium, scheduled + push/PR hooks. |
| **Tests** | Vitest: `tests/detect-regression.test.ts`, `tests/visual-smoke.test.ts`. |

### Artifacts written at run time (gitignored or local)

- `raw-reports/{run-id}/` — per-run Lighthouse JSON.
- `recordings/`, `diffs/`, `har/`, `baselines/` — as agents run (see sections below).

---

## 2. Prerequisites

- **Node.js** 20 or newer.
- **Chromium** for Playwright: after `npm install`, run `npx playwright install chromium` (CI installs with deps).
- **PostgreSQL** with the **TimescaleDB** extension for full DB features (apply `db/schema.sql` as a superuser or follow your host’s extension docs).
- Optional: **ffmpeg** on `PATH` if you extend visual QA for SSIM flicker on extracted video frames.

---

## 3. First-time setup

### Install dependencies

```bash
cd /path/to/IndiaMartTestSuit
npm install
npx playwright install chromium
```

### Database

1. Create a database and enable TimescaleDB (provider-specific).
2. Apply the schema:

   ```bash
   psql "$DATABASE_URL" -f db/schema.sql
   ```

3. Confirm connection string matches `.env` (see below).

### Environment variables

Copy `.env.example` to `.env` and fill in values:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string (or use `PGHOST` / `PGUSER` / `PGDATABASE` / `PGPASSWORD`). |
| `SLACK_WEBHOOK_URL` | Default Slack incoming webhook. |
| `SLACK_WEBHOOK_URL_PERF_ALERTS` / `SLACK_WEBHOOK_URL_PERF_LOG` | Optional separate webhooks for HIGH/CRITICAL vs MEDIUM. |
| `JIRA_BASE_URL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY`, `JIRA_USER_EMAIL` | Jira Cloud/Server REST (Phase 3 tickets). |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | AI analysis agent (Phase 3, provide either). |
| `TARGET_ENV` | e.g. `staging` or `production`. |
| `ALLOW_PRODUCTION_RUNS` | Must be `true` to allow `TARGET_ENV=production` (safety gate in orchestrator). |
| `RUN_PHASE` | `1` (vitals only), `2` (vitals + network + visual), `3` (+ script audit + LLM + Jira when DB configured). |
| `GRAFANA_BASE_URL`, `RAW_REPORTS_BASE_URL` | Links embedded in Slack messages. |
| `GITHUB_SHA` / `DEPLOY_SHA`, `PREVIOUS_SHA` | Used for run metadata and `git diff` in analysis (set in CI or locally). |

---

## 4. How to run

### Quick verification (TypeScript + unit tests, no Lighthouse)

Use this in CI or locally to confirm the repo compiles and tests pass **without** hitting the network or launching Chromium for Lighthouse:

```bash
npm run smoke
```

This runs `tsc --noEmit` then `vitest run` (same coverage as `npm test`, plus an explicit typecheck first).

### Unit tests (regression logic + smoke)

```bash
npm test
# or watch mode
npm run test:watch
```

### Performance orchestrator (main entry)

```bash
npm run test:perf
```

Useful flags (see `agents/orchestrator.ts`):

| Flag | Effect |
|------|--------|
| `--dry-run` | Skips DB writes for analysis path, Slack, and Jira where implemented; still runs heavy agents unless you add your own guard. |
| `--page <slug>` | Restricts to one page from `config/pages.ts` (e.g. `homepage`). |

Environment:

- Set `RUN_PHASE=1` | `2` | `3` to control which agent groups run (see orchestrator).

Examples:

```bash
RUN_PHASE=1 npm run test:perf -- --page homepage
RUN_PHASE=2 npm run test:perf -- --dry-run
RUN_PHASE=3 npm run test:perf
```

### Capture visual baselines (one-time or refresh)

```bash
npm run capture-baselines
# Overwrite existing baseline folders
npm run capture-baselines:force
```

Outputs under `baselines/{page-slug}/{desktop|mobile}/` and `baselines/manifest.json`.

### Compile TypeScript (optional)

```bash
npm run build
```

Output goes to `dist/` per `tsconfig.json`.

### CI

GitHub Actions workflow: `.github/workflows/perf-test.yml` — installs deps, Playwright Chromium, runs `npm run test:perf -- --dry-run`. Adjust secrets and `RUN_PHASE` to match your staging policy.

### Running on Windows

The `npm run e2e` script uses a Bash wrapper (`scripts/e2e.sh`). To run this on Windows, you have three options:

1. **WSL 2 (Recommended):** Run `npm run e2e` inside an Ubuntu WSL 2 terminal with Docker Desktop configured to use the WSL 2 backend. It will work exactly like Linux/Mac.
2. **Git Bash:** Run `npm run e2e` from Git Bash for Windows.
3. **Native PowerShell:** If you cannot use Bash, you can run the underlying Node.js commands directly:
   ```powershell
   # 1. Start Docker stack manually
   docker compose up -d
   # 2. Run the actual orchestrator
   npm run test:perf
   ```

---

## 5. How to analyze results

### 5.1 Orchestrator log line

The orchestrator logs a JSON-friendly summary via Winston, including `runId`, `phase`, `passed`, `failed`, `regressions`, and `dryRun`. Use your log aggregation or terminal output to see pass/fail counts per run.

### 5.2 Raw Lighthouse JSON

- Path pattern: **`raw-reports/<run-id>/<page-slug>-{1,2,3}.json`** (three median inputs per web vitals run).
- Open in Lighthouse viewer or diff two JSON files to compare audits (`largest-contentful-paint`, `cumulative-layout-shift`, etc.).

### 5.3 Database

- **`runs`** — one row per orchestrator run (`run_id`, `trigger_type`, `deploy_sha`, `status`, timestamps).
- **`vitals_measurements`** — metrics per page/network/run (`lcp_ms`, `cls_score`, `tbt_ms`, `lighthouse_performance_score`, `raw_json`, …).
- **`daily_vitals_summary`** — continuous aggregate for day-bucketed averages (refresh policies can be added in production).

Use **parameterized** queries only (the codebase follows this in `db/queries.ts`). Example ad-hoc checks:

```sql
SELECT page_slug, measured_at, lcp_ms, lighthouse_performance_score
FROM vitals_measurements
WHERE run_id = '<uuid>'
ORDER BY page_slug;
```

Compare current run to **7-day baseline** logic is implemented in **`getBaseline`** + **`detectRegression`** (thresholds in `config/thresholds.ts` and rules).

### 5.4 Slack and Jira

- **Slack** — regressions trigger Block Kit posts when webhooks are set; severity routing uses main vs log webhooks per `reporters/slack-reporter.ts`.
- **Jira** — Phase 3 can open or comment issues when analysis severity is HIGH/CRITICAL and env is configured (`reporters/jira-reporter.ts`).

### 5.5 Phase 2 artifacts

- **Network sim** — inspect per-profile results in orchestrator logs or extend storage; degradation flag when LCP on SLOW_3G vs 4G exceeds **3×** (`agents/network-sim-agent.ts`).
- **Visual QA** — **`diffs/<run-id>/`** PNGs (red highlights), **`recordings/<run-id>/`** for Playwright video when enabled.

### 5.6 Phase 3 analysis

- **Claude or Gemini** returns JSON validated by zod: `severity`, `summary`, `root_cause`, `affected_metrics`, `recommendation`, `confidence`.
- **Git diff** is summarized via `git diff <previous>..<current> --stat` for JS/TS/JSON (truncated in the agent).

### 5.7 Tuning alert noise

After you have **weeks of baseline data**, adjust **`config/thresholds.ts`** (see comment referencing PROMPT **U-04** in the rules/prompt pack) so alerts match your variance and avoid false positives.

---

## 6. Safety and production

- Do not set **`TARGET_ENV=production`** unless **`ALLOW_PRODUCTION_RUNS=true`** — the orchestrator enforces this.
- All target URLs should remain centralized in **`config/pages.ts`** (no scattered hardcoded IndiaMart URLs in agents).

---

## 7. Related files quick reference

| Topic | Location |
|-------|----------|
| Page list | `config/pages.ts` |
| Alert thresholds | `config/thresholds.ts` |
| CDP network profiles | `config/network-profiles.ts` |
| DB schema | `db/schema.sql` |
| Queries + regression detection | `db/queries.ts` |
| Main runner | `agents/orchestrator.ts` |

For Cursor-specific authoring rules and copy-paste phase prompts, see **`.cursor/rules/test-agent-rules.mdc`** and **`.cursor/rules/PROMPT.mdc`**.
