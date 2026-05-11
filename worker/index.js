"use strict";

const path = require("path");
const fs = require("fs/promises");
const { parse } = require("csv-parse/sync");
const { createClient } = require("redis");

const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
/** Checked in order: high first, then normal, then low (Redis BLPOP semantics). */
const QUEUE_KEYS_PRIORITY_ORDER = [
  "job_queue_high",
  "job_queue_normal",
  "job_queue_low",
];
function redisQueueKeyForPriority(priority) {
  if (priority === "high") return "job_queue_high";
  if (priority === "low") return "job_queue_low";
  return "job_queue_normal";
}
const JOBS_URL = process.env.JOBS_URL ?? "http://127.0.0.1:5050/jobs";
const FAILURE_RATE = 0.35;

/** API root derived from list URL (…/jobs -> …). */
const API_ROOT = JOBS_URL.replace(/\/jobs\/?$/, "");

const WORKER_DIR = __dirname;
const BACKEND_DIR = path.join(WORKER_DIR, "..", "backend");
const SALES_CSV = path.join(BACKEND_DIR, "data", "sales.csv");
const RECIPIENTS_CSV = path.join(BACKEND_DIR, "data", "recipients.csv");
const REPORTS_DIR = path.join(BACKEND_DIR, "reports");
const LOGS_DIR = path.join(BACKEND_DIR, "logs");

const redis = createClient({ url: REDIS_URL });

redis.on("error", (err) => {
  console.error("[worker] Redis error:", err.message);
});

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

async function fetchJob(jobId) {
  const res = await fetch(JOBS_URL);
  if (!res.ok) {
    throw new Error(`GET /jobs failed (${res.status})`);
  }
  const jobs = await res.json();
  if (!Array.isArray(jobs)) throw new Error("GET /jobs returned invalid payload");
  const job = jobs.find((j) => j && j.id === jobId);
  if (!job) throw new Error(`job id=${jobId} not found`);
  const pr = job.priority;
  const priority =
    pr === "high" || pr === "low" || pr === "normal" ? pr : "normal";
  return {
    type: typeof job.type === "string" ? job.type : "report_generation",
    priority,
    attempts: typeof job.attempts === "number" ? job.attempts : 0,
    maxAttempts: typeof job.maxAttempts === "number" ? job.maxAttempts : 3,
  };
}

async function readSalesRows() {
  const raw = await fs.readFile(SALES_CSV, "utf8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function salesStatsFromRows(rows) {
  const totalRows = rows.length;
  const amounts = [];

  for (const row of rows) {
    const raw = row.amount;
    const n =
      typeof raw === "string"
        ? Number.parseFloat(raw.trim())
        : Number(raw);
    if (Number.isFinite(n)) amounts.push(n);
  }

  const validRows = amounts.length;
  const invalidRows = totalRows - validRows;
  const totalAmount = amounts.reduce((a, b) => a + b, 0);
  const averageAmount =
    validRows > 0 ? totalAmount / validRows : 0;
  const minAmount = validRows > 0 ? Math.min(...amounts) : 0;
  const maxAmount = validRows > 0 ? Math.max(...amounts) : 0;

  return {
    totalRows,
    validRows,
    invalidRows,
    totalAmount,
    averageAmount,
    minAmount,
    maxAmount,
  };
}

async function runDataProcessing(jobId) {
  const rows = await readSalesRows();
  const stats = salesStatsFromRows(rows);
  const finishedAt = new Date().toISOString();

  return {
    kind: "data_processing",
    jobId,
    finishedAt,
    ...stats,
  };
}

async function runReportGeneration(jobId) {
  const rows = await readSalesRows();
  const stats = salesStatsFromRows(rows);
  const finishedAt = new Date().toISOString();

  await fs.mkdir(REPORTS_DIR, { recursive: true });
  const reportFile = `reports/report_${jobId}.txt`;
  const absReport = path.join(BACKEND_DIR, reportFile);

  const lines = [
    `Sales report (job ${jobId})`,
    `Generated: ${finishedAt}`,
    "",
    `Rows: ${stats.totalRows} total, ${stats.validRows} valid, ${stats.invalidRows} invalid`,
    `Total amount: ${stats.totalAmount.toFixed(2)}`,
    `Average amount: ${stats.averageAmount.toFixed(2)}`,
    `Min: ${stats.minAmount.toFixed(2)}  Max: ${stats.maxAmount.toFixed(2)}`,
    "",
    "Source: backend/data/sales.csv",
  ];

  await fs.writeFile(absReport, lines.join("\n"), "utf8");

  const summary = `Wrote text report (${stats.validRows} valid sales rows)`;

  return {
    kind: "report_generation",
    jobId,
    finishedAt,
    summary,
    reportFile,
    totalAmount: stats.totalAmount,
    averageAmount: stats.averageAmount,
  };
}

async function runEmailBatch(jobId) {
  const raw = await fs.readFile(RECIPIENTS_CSV, "utf8");
  const rows = parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  await fs.mkdir(LOGS_DIR, { recursive: true });
  const logFile = `logs/email_batch_${jobId}.log`;
  const absLog = path.join(BACKEND_DIR, logFile);

  const lines = [];
  for (const row of rows) {
    const email = row.email ?? row.Email;
    if (typeof email === "string" && email.trim()) {
      lines.push(`Sent email to ${email.trim()}`);
    }
  }

  await fs.writeFile(absLog, `${lines.join("\n")}\n`, "utf8");

  const emailsProcessed = lines.length;
  const summary = `Logged ${emailsProcessed} outbound messages`;

  return {
    kind: "email_batch",
    jobId,
    finishedAt: new Date().toISOString(),
    summary,
    logFile,
    emailsProcessed,
  };
}

async function runJobWork(type, jobId) {
  switch (type) {
    case "data_processing":
      return runDataProcessing(jobId);
    case "report_generation":
      return runReportGeneration(jobId);
    case "email_batch":
      return runEmailBatch(jobId);
    default:
      return runDataProcessing(jobId);
  }
}

async function processJob(jobId) {
  let job = null;

  try {
    job = await fetchJob(jobId);
    const type = job.type;
    const nextAttempt = job.attempts + 1;

    console.log(
      `[worker] picked job id=${jobId} type=${type} priority=${job.priority} attempt=${nextAttempt}/${job.maxAttempts}`,
    );

    await patchJob(jobId, {
      status: "running",
      attempts: nextAttempt,
      error: null,
    });
    console.log(
      `[worker] PATCH ok id=${jobId} status=running attempts=${nextAttempt}`,
    );

    console.log(`[worker] running job id=${jobId} (${type})`);
    const result = await runJobWork(type, jobId);

    if (Math.random() < FAILURE_RATE) {
      throw new Error("Simulated worker failure");
    }

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
        const q = redisQueueKeyForPriority(job.priority);
        await redis.rPush(q, jobId);
        console.log(
          `[worker] requeued job id=${jobId} queue=${q} attempt=${job.attempts + 1}/${job.maxAttempts}`,
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
  console.log(
    `[worker] queues (priority order) ${QUEUE_KEYS_PRIORITY_ORDER.join(", ")}`,
  );
  console.log(`[worker] jobs API ${JOBS_URL}, PATCH ${API_ROOT}/jobs/:id`);
  console.log(`[worker] data: ${SALES_CSV}, ${RECIPIENTS_CSV}`);
  console.log(`[worker] waiting for jobs…`);

  for (;;) {
    const popped = await redis.blPop(QUEUE_KEYS_PRIORITY_ORDER, 0);
    if (!popped) continue;
    const id = String(popped.element).trim();
    if (!id) continue;
    await processJob(id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
