import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from '../config.js';
import { sanitizeError } from '../validation/prices.js';

function createMutex() {
  let tail = Promise.resolve();
  return function exclusive(fn) {
    const run = tail.then(() => fn());
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

const managers = new Map();

export function getJobManager(root = dataDir()) {
  if (!managers.has(root)) managers.set(root, createJobManager(root));
  return managers.get(root);
}

export function createJobManager(root) {
  const jobsDir = path.join(root, 'jobs');
  const logFile = path.join(root, 'logs', 'price-operations.jsonl');
  const exclusive = createMutex();
  const memory = new Map();
  let active = null;

  async function persist(job) {
    await fs.mkdir(jobsDir, { recursive: true });
    await fs.writeFile(path.join(jobsDir, `${job.id}.json`), JSON.stringify(job));
  }

  function publicJob(job) {
    if (!job) return null;
    return {
      id: job.id,
      type: job.type,
      status: job.status,
      phase: job.phase,
      message: job.message,
      total: job.total,
      processed: job.processed,
      succeeded: job.succeeded,
      failed: job.failed,
      skipped: job.skipped,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      requestId: job.requestId || '',
      source: job.source || '',
      accepted: job.accepted || 0,
      failures: job.failures || [],
    };
  }

  return {
    async interruptStale() {
      return exclusive(async () => {
        await fs.mkdir(jobsDir, { recursive: true });
        const names = await fs.readdir(jobsDir);
        for (const name of names) {
          if (!name.endsWith('.json') || name === 'fetch-checkpoint.json') continue;
          const full = path.join(jobsDir, name);
          try {
            const job = JSON.parse(await fs.readFile(full, 'utf8'));
            if (job.status === 'running') {
              job.status = 'interrupted';
              job.finishedAt = new Date().toISOString();
              job.message = job.message || 'Interrupted because the hub restarted.';
              await fs.writeFile(full, JSON.stringify(job));
            }
          } catch {
            /* ignore unreadable job files */
          }
        }
      });
    },
    async readCheckpoint() {
      try {
        return JSON.parse(await fs.readFile(path.join(jobsDir, 'fetch-checkpoint.json'), 'utf8'));
      } catch {
        return null;
      }
    },
    async writeCheckpoint(checkpoint) {
      await fs.mkdir(jobsDir, { recursive: true });
      await fs.writeFile(path.join(jobsDir, 'fetch-checkpoint.json'), JSON.stringify(checkpoint));
    },
    async clearCheckpoint() {
      await fs.rm(path.join(jobsDir, 'fetch-checkpoint.json'), { force: true });
    },
    activeJob() {
      return publicJob(active);
    },
    async start({ type, message }) {
      return exclusive(async () => {
        if (active && active.status === 'running') {
          const error = new Error(`A ${active.type} job is already running (${active.id}).`);
          error.statusCode = 409;
          throw error;
        }
        const job = {
          id: `job_${Date.now()}_${randomUUID().slice(0, 8)}`,
          type,
          status: 'running',
          phase: 'starting',
          message: message || '',
          total: 0,
          processed: 0,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          requestId: '',
          source: '',
          failures: [],
        };
        active = job;
        memory.set(job.id, job);
        await persist(job);
        return job;
      });
    },
    async update(job, patch) {
      Object.assign(job, patch);
      if (Array.isArray(job.failures) && job.failures.length > 200) {
        job.failures = job.failures.slice(-200);
      }
      await persist(job);
      return job;
    },
    async finish(job, { status, message }) {
      job.status = status;
      job.finishedAt = new Date().toISOString();
      if (message) job.message = message;
      await persist(job);
      if (active?.id === job.id) active = null;
      return job;
    },
    async get(id) {
      if (memory.has(id)) return publicJob(memory.get(id));
      try {
        const job = JSON.parse(await fs.readFile(path.join(jobsDir, `${id}.json`), 'utf8'));
        return publicJob(job);
      } catch {
        return null;
      }
    },
    async log(entry) {
      await fs.mkdir(path.dirname(logFile), { recursive: true });
      const line = JSON.stringify({
        at: new Date().toISOString(),
        jobId: entry.jobId || '',
        action: entry.action || '',
        sku: entry.sku || '',
        outcome: entry.outcome || '',
        message: sanitizeError(entry.message || ''),
      });
      await fs.appendFile(logFile, `${line}\n`);
    },
  };
}
