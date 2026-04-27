"use strict";

const { createClient } = require("redis");

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
const QUEUE_KEY = "job_queue";
const JOBS_URL = process.env.JOBS_URL ?? "http://127.0.0.1:5050/jobs";
const FAILURE_RATE = 0.35;

/** API root derived from list URL (…/jobs -> …). */
const API_ROOT = JOBS_URL.replace(/\/jobs\/?$/, "");

/** Milliseconds to wait per job type (simulated work). */
const PROCESSING_MS = {
  report_generation: 5000,
  data_processing: 7000,
  email_batch: 4000,
};

const redis = createClient({ url: REDIS_URL });

redis.on("error", (err) => {
  console.error("[worker] Redis error:", err.message);
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function patchJobUrl(jobId) {
  return `${API_ROOT}/jobs/${encodeURIComponent(jobId)}`;
}

async function patchJob(jobId, body) {
  const res = await fetch(patchJobUrl(jobId), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`PATCH ${res.status} ${detail}`);
  }
}

function durationForType(type) {
  const ms = PROCESSING_MS[type];
  return typeof ms === "number" ? ms : PROCESSING_MS.report_generation;
}

async function fetchJob(jobId) {
  const res = await fetch(JOBS_URL);
  if (!res.ok) {
    throw new Error(`GET /jobs failed (${res.status})`);
  }
  const jobs = await res.json();
  if (!Array.isArray(jobs)) throw new Error("GET /jobs returned invalid payload");
  const job = jobs.find((j) => j && j.id === jobId);
  if (!job) throw new Error(`job id=${jobId} not found`);
  return {
    type: typeof job.type === "string" ? job.type : "report_generation",
    attempts: typeof job.attempts === "number" ? job.attempts : 0,
    maxAttempts: typeof job.maxAttempts === "number" ? job.maxAttempts : 3,
  };
}

function resultForCompletedType(type, jobId) {
  const finishedAt = new Date().toISOString();
  switch (type) {
    case "report_generation":
      return {
        kind: "report_generation",
        reportId: `rpt_${jobId.slice(0, 8)}`,
        format: "pdf",
        pageCount: 14,
        summaryIncluded: true,
        finishedAt,
      };
    case "data_processing":
      return {
        kind: "data_processing",
        inputRows: 48_200,
        outputRows: 47_891,
        bytesWritten: 2_044_128,
        finishedAt,
      };
    case "email_batch":
      return {
        kind: "email_batch",
        sent: 312,
        deferred: 4,
        bounced: 1,
        campaignRef: `cmp_${jobId.slice(0, 8)}`,
        finishedAt,
      };
    default:
      return { kind: "unknown", finishedAt };
  }
}

async function processJob(jobId) {
  let job = null;

  try {
    job = await fetchJob(jobId);
    const type = job.type;
    const ms = durationForType(type);
    const nextAttempt = job.attempts + 1;

    console.log(
      `[worker] picked job id=${jobId} type=${type} attempt=${nextAttempt}/${job.maxAttempts}`,
    );

    await patchJob(jobId, {
      status: "running",
      attempts: nextAttempt,
      error: null,
    });
    console.log(
      `[worker] PATCH ok id=${jobId} status=running attempts=${nextAttempt}`,
    );

    console.log(
      `[worker] running job id=${jobId} (simulated work ${ms / 1000}s)`,
    );
    await sleep(ms);

    if (Math.random() < FAILURE_RATE) {
      throw new Error("Simulated worker failure");
    }

    const result = resultForCompletedType(type, jobId);
    await patchJob(jobId, { status: "completed", result, error: null });
    console.log(`[worker] PATCH ok id=${jobId} status=completed`);
    console.log(`[worker] completed job id=${jobId}`);
  } catch (err) {
    console.error(`[worker] job id=${jobId} error:`, err.message);
    try {
      if (job && job.attempts + 1 < job.maxAttempts) {
        await patchJob(jobId, {
          status: "pending",
          error: err.message,
        });
        await redis.rPush(QUEUE_KEY, jobId);
        console.log(
          `[worker] requeued job id=${jobId} attempt=${job.attempts + 1}/${job.maxAttempts}`,
        );
      } else if (job) {
        await patchJob(jobId, {
          status: "failed",
          error: err.message,
          result: {
            error: err.message,
            failedAt: new Date().toISOString(),
          },
        });
        console.log(`[worker] PATCH ok id=${jobId} status=failed`);
      } else {
        console.error(
          `[worker] could not update job id=${jobId} because job metadata lookup failed`,
        );
      }
    } catch (patchErr) {
      console.error(
        `[worker] could not PATCH failed status for id=${jobId}:`,
        patchErr.message,
      );
    }
  }
}

async function main() {
  await redis.connect();
  console.log(`[worker] Redis connected (${REDIS_URL})`);
  console.log(`[worker] queue list "${QUEUE_KEY}"`);
  console.log(`[worker] jobs API ${JOBS_URL}, PATCH ${API_ROOT}/jobs/:id`);
  console.log(`[worker] waiting for jobs…`);

  for (;;) {
    const popped = await redis.blPop(QUEUE_KEY, 0);
    if (!popped) continue;
    const jobId = String(popped.element).trim();
    if (!jobId) continue;
    await processJob(jobId);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
