'use strict';

/*
 * Adversary Console routes.
 *
 * All routes are workspace-scoped and sit behind the existing auth middleware
 * (req.actor is set by server/index.js before any route runs).
 *
 * GET  /api/adversary/catalog        — attack metadata, no execution
 * POST /api/adversary/run            — { attackIds?: string[] } → { runId }
 * GET  /api/adversary/run/:id        — status + results; supports polling
 * GET  /api/adversary/run/:id/report.pdf — Containment Report PDF
 *
 * Any desk may run the console (read-only in effect due to shadow isolation).
 * The report records which desk ran it and when.
 */

const { ALL_ATTACKS } = require('../adversary/attacks');
const { run: runAttacks } = require('../adversary/runner');
const { buildReport, renderReport } = require('../adversary/report');
const { summarise } = require('../adversary/evidence');
const identity = require('../identity');
const checkout = require('../checkout');
const payments = require('../payments');

/* In-memory run store: runId -> { status, result, startedAt, desk } */
const runs = new Map();

function makeRouter(app, chain, workspace) {
  const wrap = (fn) => async (req, res) => {
    const id = workspace.workspaceIdFrom(req);
    try {
      await workspace.withLock(id, async () => {
        await workspace.loadSession(req);
        let body; let declared = false;
        const send = res.json.bind(res);
        res.json = (b) => { body = b; declared = true; return res; };
        try {
          await fn(req, res);
          await workspace.saveSession(req);
        } finally {
          res.json = send;
        }
        if (declared) send(body);
      });
    } catch (e) {
      const msg = String(e.shortMessage || e.message || 'Request failed');
      const status = e.status || (e.conflict ? 409 : 400);
      res.status(status).json({ error: msg.split('\n')[0].slice(0, 300) });
    }
  };

  /* ------------------------------------------------------------------ */
  /*  GET /api/adversary/catalog                                          */
  /* ------------------------------------------------------------------ */
  app.get('/api/adversary/catalog', wrap(async (req, res) => {
    res.json(ALL_ATTACKS.map((a) => ({
      id: a.id,
      title: a.title,
      class: a.class,
      vector: a.vector,
      entryPoint: a.entryPoint,
      targetBoundary: a.targetBoundary,
      enforcementLayer: a.enforcementLayer,
      hypothesis: a.hypothesis,
      severity: a.severity,
    })));
  }));

  /* ------------------------------------------------------------------ */
  /*  POST /api/adversary/run                                             */
  /* ------------------------------------------------------------------ */
  app.post('/api/adversary/run', wrap(async (req, res) => {
    const session = workspace.sessionFor(req);
    // Any signed-in role may run (read-only due to shadow isolation)
    if (!req.actor) {
      const e = new Error('Sign in to run the adversary console.');
      e.status = 401;
      throw e;
    }

    const attackIds = Array.isArray(req.body && req.body.attackIds)
      ? req.body.attackIds.filter((id) => ALL_ATTACKS.some((a) => a.id === id))
      : null;

    const runId = require('crypto').randomBytes(8).toString('hex');
    const desk = req.actor ? req.actor.role : 'unknown';
    const now = new Date().toISOString();

    runs.set(runId, { status: 'running', startedAt: now, desk, workspaceId: session.id, result: null });

    // Determine server URL
    const host = req.headers.host || 'localhost:4000';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const serverUrl = `${proto}://${host}`;

    // Run asynchronously
    setImmediate(async () => {
      try {
        const result = await runAttacks({ attackIds, serverUrl });
        runs.set(runId, { status: 'complete', startedAt: now, completedAt: result.completedAt, desk, workspaceId: session.id, result });
      } catch (e) {
        runs.set(runId, { status: 'error', startedAt: now, desk, workspaceId: session.id, error: e.message });
      }
    });

    res.json({ runId, status: 'running', startedAt: now });
  }));

  /* ------------------------------------------------------------------ */
  /*  GET /api/adversary/run/:id                                          */
  /* ------------------------------------------------------------------ */
  app.get('/api/adversary/run/:id', wrap(async (req, res) => {
    if (!req.actor) {
      const e = new Error('Sign in to view adversary results.');
      e.status = 401;
      throw e;
    }

    const rec = runs.get(req.params.id);
    if (!rec) {
      res.status(404).json({ error: 'Run not found.' });
      return;
    }

    if (rec.status === 'running') {
      res.json({ runId: req.params.id, status: 'running', startedAt: rec.startedAt });
      return;
    }

    if (rec.status === 'error') {
      res.json({ runId: req.params.id, status: 'error', error: rec.error });
      return;
    }

    const r = rec.result;
    res.json({
      runId: req.params.id,
      status: 'complete',
      startedAt: rec.startedAt,
      completedAt: rec.completedAt,
      desk: rec.desk,
      stats: r.stats,
      evidenceHash: r.evidenceHash,
      evidences: r.evidences,
    });
  }));

  /* ------------------------------------------------------------------ */
  /*  GET /api/adversary/run/:id/report.pdf                               */
  /* ------------------------------------------------------------------ */
  app.get('/api/adversary/run/:id/report.pdf', async (req, res) => {
    if (!req.actor) {
      res.status(401).json({ error: 'Sign in to download the report.' });
      return;
    }

    const rec = runs.get(req.params.id);
    if (!rec || rec.status !== 'complete') {
      res.status(404).json({ error: 'Run not found or not yet complete.' });
      return;
    }

    try {
      const chainId = chain && chain.chainId ? chain.chainId : 'in-process';
      const store = workspace.getStore();
      const report = buildReport(rec.result, {
        desk: rec.desk,
        chainId: String(chainId),
        durability: store ? store.kind : 'memory',
        railsLive: !!(checkout.isLive() || payments.configured()),
        commitSha: process.env.GIT_COMMIT_SHA || null,
      });
      const pdf = await renderReport(report);
      res.set('content-type', 'application/pdf');
      res.set('content-disposition', `attachment; filename="containment-report-${req.params.id}.pdf"`);
      res.send(pdf);
    } catch (e) {
      res.status(500).json({ error: `Could not render report: ${e.message}` });
    }
  });

  return app;
}

module.exports = { makeRouter, runs };
