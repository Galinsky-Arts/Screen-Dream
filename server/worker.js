// Background worker: runs queued step jobs (a few at a time), resumes after restarts, and
// auto-approves previews whose review window has passed.
const { query } = require('./db');
const pipeline = require('./pipeline');

const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 2);
const TICK_MS = Number(process.env.WORKER_TICK_MS || 2000);
let active = 0;
let timer = null;

async function claim() {
  const { rows } = await query(`UPDATE jobs SET status='running', started_at=now()
    WHERE id = (SELECT j.id FROM jobs j JOIN projects p ON p.id = j.project_id
                WHERE j.status='queued' AND p.status <> 'paused' AND NOT coalesce((p.policy->>'paused')::boolean,false)
                ORDER BY j.id LIMIT 1 FOR UPDATE SKIP LOCKED)
    RETURNING *`);
  return rows[0] || null;
}

async function tick() {
  try {
    await pipeline.autoApproveDue();
    while (active < CONCURRENCY) {
      const job = await claim();
      if (!job) break;
      active++;
      pipeline.runJob(job)
        .then(() => query(`UPDATE jobs SET status='done', finished_at=now() WHERE id=$1`, [job.id]))
        .catch((e) => { console.error(`job ${job.id} ${job.step_id}:`, e.message); return query(`UPDATE jobs SET status='failed', error=$2, finished_at=now() WHERE id=$1`, [job.id, e.message.slice(0, 1000)]); })
        .finally(() => { active--; setImmediate(tick); });
    }
  } catch (e) {
    console.error('worker tick', e.message);
  }
}

async function start() {
  // Jobs that were running when the server stopped start again; steps keep their saved progress.
  await query(`UPDATE jobs SET status='queued' WHERE status='running'`);
  await query(`UPDATE steps SET status='queued' WHERE status='running'`);
  timer = setInterval(tick, TICK_MS);
  tick();
}

module.exports = { start, tick, stop: () => clearInterval(timer) };
