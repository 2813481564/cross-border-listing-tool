/**
 * 内存任务队列：采集任务在这里排队、串行执行、对外暴露进度。
 *
 * 为什么放内存：队列只是「运行态」，进程重启即清空；采集出来的商品与媒体仍在 SQLite 里，
 * 不会因为重启丢数据，也就不用给队列表加迁移。
 *
 * 执行仍然是串行的（同一个 Chrome 页面 + 1688 风控，并行只会更容易被拦），
 * 但这个「串行」现在是被看得见的：谁在跑、跑到哪一步、谁在排队。
 */

const MAX_JOBS = 60;

let counter = 0;
let handler = null;
let running = false;
const jobs = [];

/** 真正的采集逻辑由 index.mjs 注册，避免 jobs 反向依赖业务模块 */
export function setJobHandler(fn) {
  handler = fn;
}

function newId() {
  counter += 1;
  return `job-${Date.now().toString(36)}-${counter}`;
}

/** 新任务从队尾进入；已完成的旧任务超过上限时淘汰最老的 */
function trim() {
  const finished = jobs.filter((j) => j.status === 'succeeded' || j.status === 'failed');
  if (finished.length <= MAX_JOBS) return;
  const drop = new Set(finished.slice(MAX_JOBS).map((j) => j.id));
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    if (drop.has(jobs[i].id)) jobs.splice(i, 1);
  }
}

export function enqueueJob({ url, options = {} }) {
  const job = {
    id: newId(),
    url,
    offerId: null,
    title: '',
    price: null,
    currency: null,
    status: 'queued',
    stage: '排队中',
    detail: '',
    progress: null,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    options
  };
  // 展示用「最新的在最前」，取任务时另外按 oldest-first 挑
  jobs.unshift(job);
  trim();
  pump();
  return job;
}

/** 队列里最老的那个排队任务：先来先跑 */
function nextQueued() {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    if (jobs[i].status === 'queued') return jobs[i];
  }
  return null;
}

async function pump() {
  if (running || !handler) return;
  running = true;
  try {
    for (;;) {
      const job = nextQueued();
      if (!job) break;

      job.status = 'running';
      job.stage = '采集中';
      job.startedAt = new Date().toISOString();

      try {
        const result = await handler(job);
        job.status = 'succeeded';
        job.stage = '已完成';
        job.detail = '';
        job.progress = null;
        if (result?.offerId) job.offerId = result.offerId;
      } catch (err) {
        job.status = 'failed';
        job.stage = '失败';
        job.error = err?.message ?? String(err);
        job.progress = null;
      }

      job.finishedAt = new Date().toISOString();
    }
  } finally {
    running = false;
  }
}

export function listJobs() {
  return jobs.map((j) => ({ ...j }));
}

export function getJob(id) {
  return jobs.find((j) => j.id === id) ?? null;
}

/** 重采：用同样的链接和参数再排一个新任务，旧任务记录保留 */
export function retryJob(id) {
  const job = jobs.find((j) => j.id === id);
  if (!job) return null;
  return enqueueJob({ url: job.url, options: job.options });
}

export function clearFinishedJobs() {
  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const s = jobs[i].status;
    if (s === 'succeeded' || s === 'failed') jobs.splice(i, 1);
  }
}

export function jobStats() {
  let queued = 0;
  let active = 0;
  for (const job of jobs) {
    if (job.status === 'queued') queued += 1;
    else if (job.status === 'running') active += 1;
  }
  return { queued, running: active, active: queued + active };
}
