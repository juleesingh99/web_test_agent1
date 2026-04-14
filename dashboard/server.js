/**
 * dashboard/server.js
 *
 * Lightweight Express server that wraps the IndiaMart Perf Suite npm scripts.
 * - REST endpoints to trigger actions (e2e phases, PDF generation, etc.)
 * - SSE stream for live terminal output
 * - File serving for PDF / HTML report preview
 *
 * Start: node dashboard/server.js   (from project root)
 *    or: npm run dashboard
 */

'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const fsp     = fs.promises;
const { spawn } = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────

const PORT     = process.env.DASHBOARD_PORT || 4000;
const ROOT_DIR = path.resolve(__dirname, '..');

// Resolve npm executable via nvm if plain `npm` isn't on $PATH
function getNpmPath() {
  const candidates = [
    'npm',
    `${process.env.HOME}/.nvm/versions/node/v22.22.1/bin/npm`,
    `${process.env.HOME}/.nvm/versions/node/v20.20.1/bin/npm`,
    '/usr/local/bin/npm',
    '/opt/homebrew/bin/npm',
  ];
  for (const c of candidates) {
    try {
      require('child_process').execSync(`"${c}" --version`, { stdio: 'ignore' });
      return c;
    } catch {}
  }
  return 'npm';
}

const NPM = getNpmPath();

// ── Job state ─────────────────────────────────────────────────────────────────

let job = null; // { proc, action, startedAt, lines: [], sseClients: Set }

function broadcast(text) {
  if (!job) return;
  job.lines.push(text);
  for (const res of job.sseClients) {
    res.write(`data: ${JSON.stringify({ text })}\n\n`);
  }
}

function broadcastDone(code) {
  if (!job) return;
  const msg = `\n\x1b[${code === 0 ? '32' : '31'}m[dashboard] Process exited with code ${code}\x1b[0m\n`;
  broadcast(msg);
  for (const res of job.sseClients) {
    res.write(`data: ${JSON.stringify({ done: true, code })}\n\n`);
    res.end();
  }
  job.exitCode = code;
  job.proc = null;
}

// ── Allowed actions ───────────────────────────────────────────────────────────

const ACTIONS = {
  'e2e':               { script: 'e2e',               label: 'E2E Phase 1' },
  'e2e:phase2':        { script: 'e2e:phase2',         label: 'E2E Phase 2' },
  'e2e:phase3':        { script: 'e2e:phase3',         label: 'E2E Phase 3' },
  'report:pdf':        { script: 'report:pdf',          label: 'Generate PDF Report' },
  'capture-baselines': { script: 'capture-baselines',  label: 'Capture Baselines' },
  'sitemap:preview':   { script: 'sitemap:preview',    label: 'Sitemap Preview' },
  'test':              { script: 'test',                label: 'Run Unit Tests' },
};

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// Serve static dashboard UI
app.use(express.static(__dirname));

// ── GET /api/actions ──────────────────────────────────────────────────────────
app.get('/api/actions', (_req, res) => {
  res.json(Object.entries(ACTIONS).map(([id, info]) => ({ id, ...info })));
});

// ── GET /api/status ───────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  if (!job) return res.json({ running: false });
  res.json({
    running: !!job.proc,
    action: job.action,
    startedAt: job.startedAt,
    exitCode: job.exitCode ?? null,
    lineCount: job.lines.length,
  });
});

// ── GET /api/runs ─────────────────────────────────────────────────────────────
app.get('/api/runs', async (_req, res) => {
  try {
    const rawDir     = path.join(ROOT_DIR, 'raw-reports');
    const reportsDir = path.join(ROOT_DIR, 'reports');

    async function listDirs(dir) {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        return entries.filter(e => e.isDirectory()).map(e => e.name);
      } catch { return []; }
    }

    const rawIds     = await listDirs(rawDir);
    const reportIds  = await listDirs(reportsDir);
    const allIds     = [...new Set([...rawIds, ...reportIds])];

    const runs = await Promise.all(allIds.map(async (id) => {
      const rawPath    = path.join(rawDir, id);
      const reportPath = path.join(reportsDir, id);

      let mtime = null;
      try { mtime = (await fsp.stat(rawPath)).mtime; } catch {}
      try { mtime = mtime || (await fsp.stat(reportPath)).mtime; } catch {}

      const hasPdf  = fs.existsSync(path.join(reportPath, 'performance-report.pdf'));
      const hasHtml = fs.existsSync(path.join(reportPath, 'performance-report.html'));

      let jsonCount = 0;
      try {
        const files = await fsp.readdir(rawPath);
        jsonCount = files.filter(f => f.endsWith('.json')).length;
      } catch {}

      return { id, mtime, hasPdf, hasHtml, jsonCount };
    }));

    runs.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/run ─────────────────────────────────────────────────────────────
app.post('/api/run', (req, res) => {
  const { action, runId } = req.body || {};

  if (!action || !ACTIONS[action]) {
    return res.status(400).json({ error: `Unknown action: ${action}` });
  }
  if (job && job.proc) {
    return res.status(409).json({ error: 'A job is already running. Please wait.' });
  }

  const script = ACTIONS[action].script;
  const args   = ['run', script];

  // Pass --run-id for PDF generation if provided
  if (action === 'report:pdf' && runId) {
    args.push('--', '--run-id', runId);
  }

  const proc = spawn(NPM, args, {
    cwd:      ROOT_DIR,
    env:      { ...process.env, FORCE_COLOR: '1' },
    shell:    false,
    detached: true,   // put the whole process tree in its own process group
    stdio:    ['ignore', 'pipe', 'pipe'],
  });
  // Unref so the dashboard itself can exit independently if needed
  proc.unref();

  job = {
    proc,
    action,
    startedAt: new Date().toISOString(),
    lines: [],
    sseClients: new Set(),
    exitCode: null,
  };

  const welcome = `\x1b[36m[dashboard] Starting: npm run ${script}\x1b[0m\n\n`;
  job.lines.push(welcome);

  proc.stdout.on('data', d => broadcast(d.toString()));
  proc.stderr.on('data', d => broadcast(d.toString()));
  proc.on('close', code => broadcastDone(code));
  proc.on('error', err  => {
    broadcast(`\x1b[31m[dashboard] Failed to start process: ${err.message}\x1b[0m\n`);
    broadcastDone(1);
  });

  res.json({ ok: true, action, script });
});

// ── POST /api/kill ────────────────────────────────────────────────────────────
app.post('/api/kill', (_req, res) => {
  if (!job || !job.proc) return res.json({ ok: true, message: 'No running job' });

  const pgid = job.proc.pid;
  broadcast('\n\x1b[33m[dashboard] Stopping job (killing process group)…\x1b[0m\n');

  try {
    // Kill the entire process group (negative pid = group id) so bash/tsx/chrome all die
    process.kill(-pgid, 'SIGKILL');
  } catch (e) {
    // Fallback: kill just the direct child
    try { job.proc.kill('SIGKILL'); } catch {}
  }

  res.json({ ok: true, message: 'Process group killed' });
});

// ── GET /api/log (SSE) ────────────────────────────────────────────────────────
app.get('/api/log', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  // Send heartbeat every 15 s to keep connection alive
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);

  if (!job) {
    res.write(`data: ${JSON.stringify({ text: '\x1b[33m[dashboard] No job has been started yet.\x1b[0m\n' })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true, code: 0 })}\n\n`);
    clearInterval(heartbeat);
    return res.end();
  }

  // Replay buffered lines
  for (const line of job.lines) {
    res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
  }

  // If process already finished, send done immediately
  if (!job.proc) {
    res.write(`data: ${JSON.stringify({ done: true, code: job.exitCode })}\n\n`);
    clearInterval(heartbeat);
    return res.end();
  }

  // Subscribe to live output
  job.sseClients.add(res);
  req.on('close', () => {
    clearInterval(heartbeat);
    if (job) job.sseClients.delete(res);
  });
});

// ── GET /api/file/* ───────────────────────────────────────────────────────────
app.get('/api/file/*filepath', (req, res) => {
  // Express 5 wildcard params can be arrays — extract from URL path directly
  const prefix       = '/api/file/';
  const relativePath = decodeURIComponent(req.path.slice(prefix.length));
  const safePath     = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath     = path.join(ROOT_DIR, safePath);

  // Only allow serving from reports/ directory
  if (!filePath.startsWith(path.join(ROOT_DIR, 'reports'))) {
    return res.status(403).json({ error: 'Access denied' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = {
    '.pdf':  'application/pdf',
    '.html': 'text/html',
    '.json': 'application/json',
  }[ext] || 'application/octet-stream';

  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', 'inline');
  fs.createReadStream(filePath).pipe(res);
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  ┌─────────────────────────────────────────────┐`);
  console.log(`  │   IndiaMart Perf Suite — Dashboard          │`);
  console.log(`  │   http://localhost:${PORT}                      │`);
  console.log(`  └─────────────────────────────────────────────┘\n`);
});
