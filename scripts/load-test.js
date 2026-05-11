"use strict";

/**
 * Load test: burst POST /jobs, then poll GET /jobs until all tracked jobs finish or timeout.
 *
 * Usage:
 *   node scripts/load-test.js 200 25
 *   node scripts/load-test.js [--total|-n 200] [--concurrency|-c 25] [--timeout|-t 300]
 *
 * Timeout is in seconds (default 300 = 5 minutes).
 */

const BASE_URL = process.env.JOBS_API_URL ?? "http://localhost:5050";
const JOBS_URL = `${BASE_URL.replace(/\/$/, "")}/jobs`;

const TYPES = ["data_processing", "report_generation", "email_batch"];
const PRIORITIES = ["low", "normal", "high"];

function parseArgs(argv) {
  let total = 200;
  let concurrency = 25;
  let timeoutSec = 300;

  let i = 2;
  const a2 = argv[2];
  const a3 = argv[3];
  if (
    typeof a2 === "string" &&
    typeof a3 === "string" &&
    /^\d+$/.test(a2) &&
    /^\d+$/.test(a3)
  ) {
    total = Number(a2);
    concurrency = Number(a3);
    i = 4;
  }

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--total" || a === "-n") {
      total = Number(argv[++i]);
    } else if (a === "--concurrency" || a === "-c") {
      concurrency = Number(argv[++i]);
    } else if (a === "--timeout" || a === "-t") {
      timeoutSec = Number(argv[++i]);
    } else if (a === "--help" || a === "-h") {
      console.log(`
Usage: node scripts/load-test.js [options]

Positional (same as -n and -c):
  node scripts/load-test.js <total> <concurrency>

Options:
  -n, --total <n>         Total jobs to submit (default: 200)
  -c, --concurrency <n>   Parallel POST requests (default: 25)
  -t, --timeout <sec>     Max wait after submit phase (default: 300 = 5 min)
  -h, --help              Show this help

Environment:
  JOBS_API_URL            Base URL (default: http://localhost:5050)
`);
      process.exit(0);
    }
  }

  if (!Number.isFinite(total) || total < 1) {
    console.error("Invalid --total: must be a positive integer");
    process.exit(1);
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    console.error("Invalid --concurrency: must be a positive integer");
    process.exit(1);
  }
  if (!Number.isFinite(timeoutSec) || timeoutSec < 1) {
    console.error("Invalid --timeout: must be a positive number (seconds)");
    process.exit(1);
  }

  return {
    total: Math.floor(total),
    concurrency: Math.floor(concurrency),
    timeoutMs: Math.floor(timeoutSec) * 1000,
  };
}

function pickTypeAndPriority(index) {
  return {
    type: TYPES[index % TYPES.length],
    priority: PRIORITIES[index % PRIORITIES.length],
  };
}

async function submitJob(index) {
  const { type, priority } = pickTypeAndPriority(index);
  const res = await fetch(JOBS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, priority }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    return { ok: false, index, type, priority, status: res.status, body };
  }
  const id = body && typeof body.id === "string" ? body.id : null;
  if (!id) {
    return {
      ok: false,
      index,
      type,
      priority,
      status: res.status,
      body,
      reason: "missing id in response",
    };
  }
  return { ok: true, index, type, priority, id };
}

async function runBurst(total, concurrency) {
  let success = 0;
  let failed = 0;
  /** @type {string[]} */
  const jobIds = [];

  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= total) break;
      try {
        const r = await submitJob(i);
        if (r.ok) {
          success += 1;
          jobIds.push(r.id);
        } else {
          failed += 1;
          if (failed <= 5) {
            console.error(
              `[submit fail #${failed}] index=${i} status=${r.status} ${JSON.stringify(r.body ?? r.reason ?? "").slice(0, 200)}`,
            );
          }
        }
      } catch (err) {
        failed += 1;
        if (failed <= 5) {
          console.error(`[submit fail #${failed}] index=${i}`, err.message);
        }
      }
    }
  }

  const workers = Math.min(concurrency, total);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return { success, failed, jobIds };
}

async function fetchAllJobs() {
  const res = await fetch(JOBS_URL);
  if (!res.ok) {
    throw new Error(`GET /jobs ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("GET /jobs: expected array");
  }
  return data;
}

function countTrackedStatuses(jobs, idSet) {
  let pending = 0;
  let running = 0;
  let completed = 0;
  let failed = 0;

  for (const job of jobs) {
    if (!job || typeof job.id !== "string" || !idSet.has(job.id)) continue;
    const s = job.status;
    if (s === "pending") pending += 1;
    else if (s === "running") running += 1;
    else if (s === "completed") completed += 1;
    else if (s === "failed") failed += 1;
  }

  return { pending, running, completed, failed };
}

function formatCounts(c) {
  return `pending=${c.pending} running=${c.running} completed=${c.completed} failed=${c.failed}`;
}

async function main() {
  const opts = parseArgs(process.argv);
  const scriptStart = Date.now();

  console.log("");
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Distributed task scheduler — load test");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  API:          ${JOBS_URL}`);
  console.log(`  Jobs:         ${opts.total}`);
  console.log(`  Concurrency:  ${opts.concurrency}`);
  console.log(`  Poll timeout: ${opts.timeoutMs / 1000}s`);
  console.log(`  Job mix:      types [${TYPES.join(", ")}]`);
  console.log(`                priorities [${PRIORITIES.join(", ")}] (rotated)`);
  console.log("══════════════════════════════════════════════════════════");
  console.log("");

  console.log("[phase 1] Submitting jobs (burst)…");
  const submitStart = Date.now();
  const { success, failed, jobIds } = await runBurst(opts.total, opts.concurrency);
  const submitEnd = Date.now();
  const submitMs = submitEnd - submitStart;
  const submitPerSec =
    submitMs > 0 ? (success / (submitMs / 1000)).toFixed(2) : "0.00";

  console.log("");
  console.log("[phase 1] Submit finished.");
  console.log(`          Total attempted:  ${opts.total}`);
  console.log(`          Successful:       ${success}`);
  console.log(`          Failed:           ${failed}`);
  console.log(`          Wall time:        ${(submitMs / 1000).toFixed(2)}s`);
  console.log(`          Throughput:       ${submitPerSec} jobs/sec (successful)`);
  console.log("");

  if (jobIds.length === 0) {
    console.log("[phase 2] Skipped — no job IDs to track.");
    console.log("");
    console.log("──────── FINAL SUMMARY ────────");
    console.log(`  Submitted (success):  0`);
    console.log(`  Submitted (failed):   ${failed}`);
    console.log(`  Completed jobs:       0`);
    console.log(`  Failed jobs:          0`);
    console.log(`  Total time:           ${((Date.now() - scriptStart) / 1000).toFixed(2)}s`);
    console.log(`  Throughput (overall): 0 jobs/sec`);
    console.log("────────────────────────────────");
    process.exit(failed > 0 ? 1 : 0);
  }

  const idSet = new Set(jobIds);
  console.log("[phase 2] Polling GET /jobs every 3s until all tracked jobs are done…");
  console.log(`          Tracking ${jobIds.length} job IDs.`);

  const pollIntervalMs = 3000;
  const deadline = Date.now() + opts.timeoutMs;
  let pollRound = 0;
  let lastCounts = null;
  let allTrackedTerminal = false;

  while (Date.now() < deadline) {
    pollRound += 1;
    let jobs;
    try {
      jobs = await fetchAllJobs();
    } catch (err) {
      console.error(`[poll #${pollRound}] GET /jobs error:`, err.message);
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      continue;
    }

    const c = countTrackedStatuses(jobs, idSet);
    lastCounts = c;
    const elapsed = ((Date.now() - scriptStart) / 1000).toFixed(0);
    console.log(
      `[poll #${pollRound}] +${elapsed}s  ${formatCounts(c)}  (tracked=${jobIds.length})`,
    );

    const finished = c.completed + c.failed;
    if (finished >= jobIds.length) {
      allTrackedTerminal = true;
      console.log("");
      console.log("[phase 2] All tracked jobs reached a terminal state.");
      break;
    }

    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  const scriptEnd = Date.now();
  const totalMs = scriptEnd - scriptStart;

  if (!allTrackedTerminal) {
    console.log("");
    if (lastCounts) {
      const finished = lastCounts.completed + lastCounts.failed;
      console.warn(
        `[phase 2] TIMEOUT after ${opts.timeoutMs / 1000}s — ${finished}/${jobIds.length} tracked jobs terminal.`,
      );
    } else {
      console.warn(
        `[phase 2] TIMEOUT after ${opts.timeoutMs / 1000}s — could not read job statuses.`,
      );
    }
  }

  const finalCompleted = lastCounts ? lastCounts.completed : 0;
  const finalFailedJobs = lastCounts ? lastCounts.failed : 0;

  console.log("");
  console.log("══════════════════════════════════════════════════════════");
  console.log("  FINAL SUMMARY");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  Jobs attempted (POST):     ${opts.total}`);
  console.log(`  Successful submissions:    ${success}`);
  console.log(`  Failed submissions:        ${failed}`);
  console.log(`  Tracked job IDs:           ${jobIds.length}`);
  console.log(`  Completed jobs (tracked):  ${finalCompleted}`);
  console.log(`  Failed jobs (tracked):     ${finalFailedJobs}`);
  console.log(`  Total time (wall clock):   ${(totalMs / 1000).toFixed(2)}s`);
  const terminalTracked = finalCompleted + finalFailedJobs;
  const overallPerSec =
    totalMs > 0
      ? (terminalTracked / (totalMs / 1000)).toFixed(2)
      : "0.00";
  console.log(`  Throughput (terminal jobs/s): ${overallPerSec} jobs/sec`);
  console.log("══════════════════════════════════════════════════════════");
  console.log("");

  const timedOut = !allTrackedTerminal;

  process.exit(timedOut ? 2 : failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
