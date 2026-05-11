# Live demo script — Distributed Task Scheduling Platform

Use this document as a **run-of-show** for a 12–18 minute capstone demo. Adjust container names and paths if your machine differs.

**Before the audience arrives:** confirm `backend/.env` has `DATABASE_URL`, optional `REDIS_URL` / `PORT`; confirm `backend/data/sales.csv` and `backend/data/recipients.csv` exist.

---

## Step 1 — Show Docker: Redis and PostgreSQL

**Do**

- In a terminal:

  ```bash
  docker ps
  ```

  If containers are stopped, start them (names may vary on your host):

  ```bash
  docker start redis-dev postgres-dev
  docker ps
  ```

**Say**

> “The scheduler does not hold jobs in memory in the API. **PostgreSQL** is the system of record for every job row, and **Redis** holds the work queues so API and workers stay decoupled. Here are both services running under Docker.”

---

## Step 2 — Start the backend API

**Do**

- New terminal, from repo root:

  ```bash
  cd backend && node index.js
  ```

- Leave logs visible. Confirm a line like server listening on **5050** and Postgres/Redis connected.

**Say**

> “This is the **Express** job API: it accepts submissions, writes to Postgres, and **pushes job IDs** onto Redis lists by priority. Workers never talk to the browser directly—only to this API and Redis.”

---

## Step 3 — Start one worker

**Do**

- New terminal:

  ```bash
  cd worker && node index.js
  ```

- Leave logs visible (queue names, `JOBS_URL`, “waiting for jobs…”).

**Say**

> “A **worker** is a separate process. It blocks on Redis with a priority-ordered pop, pulls a job ID, loads metadata from `GET /jobs`, marks the job **running**, does the real task, then **PATCH**es **completed** or handles failure and retries. I’m starting with **one** worker so the lifecycle is easy to read.”

---

## Step 4 — Start the frontend dashboard

**Do**

- New terminal, repo root:

  ```bash
  npm run dev
  ```

- Open **http://localhost:3000** (or the URL Next prints). Confirm the task scheduler UI loads.

**Say**

> “The UI is **Next.js**. It talks to `/api/jobs`, which the dev server **proxies** to Express on port **5050**. The table **polls every two seconds** so we see state changes without refreshing manually.”

---

## Step 5 — Single `data_processing` job (pending → running → completed)

**Do**

- In the UI: choose **Task type** → `data_processing`, **Priority** → `normal` (default is fine). Click **Submit**.
- Point at the new row: **pending** → **running** → **completed**; note **Result** shows “CSV processed” and metrics cards update.

**Say**

> “**Pending** means the row exists in Postgres and the ID is on a Redis queue, but no worker has claimed it yet. **Running** means a worker PATCHed the job and is executing CSV work. **Completed** means the worker wrote the JSON result back. Nothing about the job’s durability lives in the worker process—it’s all API + database.”

---

## Step 6 — Show worker logs

**Do**

- Switch to the **worker** terminal. Scroll to lines for the job you just ran: `picked job`, `PATCH … running`, `running job`, `PATCH … completed` (or retry lines if a simulated failure fired).

**Say**

> “These logs are the **consumer side** of the story: dequeue, PATCH lifecycle, then real work. If I ran multiple workers, you’d see the same pattern interleaved—each worker is stateless and races on the same queues.”

---

## Step 7 — Job details and the result payload

**Do**

- In the UI, click **View details** on the completed `data_processing` job.
- Walk through JSON: `kind`, row counts, `totalAmount`, `averageAmount`, etc.

**Say**

> “The table stays readable with a **short label**; the modal is the **full contract** between worker and API: structured fields the dashboard could graph later. This job read `backend/data/sales.csv` and computed aggregates in process.”

---

## Step 8 — `report_generation` and `email_batch`

**Do**

- Submit **report_generation** (normal priority). When it completes, optionally open `backend/reports/report_<jobId>.txt` in the editor or `cat` in a terminal.
- Submit **email_batch**. When it completes, show `backend/logs/email_batch_<jobId>.log` (one line per recipient).
- Use **View details** on each job to tie files to `reportFile` / `logFile` in JSON.

**Say**

> “Same pipeline, different **task types**: one writes a **text report** under `backend/reports/`, the other simulates a bulk send and writes a **log** under `backend/logs/`. The API still only stores metadata and JSON results—the heavy lifting is local I/O in the worker.”

---

## Step 9 — Retries and failure attempts

**Do**

- Explain: the worker includes a **random simulated failure** after work finishes (configurable rate in `worker/index.js`). Under load you will see occasional **requeue**: status returns to **pending**, **Attempts** increments, **Error** may show the last message.
- Optionally submit several jobs quickly until one fails and retries, or cite a prior run.

**Say**

> “Distributed jobs **fail**: networks blip, processes restart. Here we **simulate** that: on failure the worker PATCHes **pending**, pushes the same job ID back onto the **same priority queue**, and bumps attempts until **max attempts**—then the job goes **failed** with a terminal result. That’s **at-least-once style** execution with a bounded retry policy.”

---

## Step 10 — Priority scheduling

**Do**

- Submit three jobs in quick succession: same type (e.g. `data_processing`), priorities **low**, **normal**, **high** (submit in that order to make the contrast obvious).
- With **one** worker, observe dequeue order: **high** should finish before **normal**, before **low**, even though submission order differed.

**Say**

> “The API enqueues to **three Redis lists**. The worker uses a single **BLPOP** on `job_queue_high`, then `job_queue_normal`, then `job_queue_low`—so **high always wins** when work exists. Retries reuse the same list so priority is preserved after a failure.”

---

## Step 11 — Load test (burst)

**Do**

- Ensure backend + **one** worker + Redis + Postgres are up. Optionally clear old jobs or keep them—script tracks only IDs it creates.
- New terminal, repo root:

  ```bash
  node scripts/load-test.js 200 25
  ```

- Let it print submit stats, then poll lines until finished or timeout. Optionally keep the dashboard visible so the audience sees the table and metric cards move.

**Say**

> “This script **bursts** two hundred `POST /jobs` with mixed types and priorities, then polls `GET /jobs` until those IDs are all terminal. It reports submit throughput and how long completion took—classic **stress** of the API + queue + single consumer.”

---

## Step 12 — Three workers and throughput

**Do**

- Stop the load test if still running. **Keep the backend and DB.**
- Open **two more** terminals and start two additional workers from `worker/` (three terminals total running `node index.js`), or stop all workers and start three fresh.
- Run the same load test again:

  ```bash
  node scripts/load-test.js 200 25
  ```

- Compare wall time / jobs per second to the **one-worker** run (example numbers you can quote if similar: **~16.5 s @ ~12 jobs/s** vs **~10 s @ ~20 jobs/s** with three workers).

**Say**

> “Workers are **horizontally scalable**: more consumers drain Redis faster when CPU and I/O allow. Throughput should improve until we hit Postgres, Redis, or disk limits—that’s the shape of real production tuning.”

---

## Step 13 — Restart backend, Postgres persistence

**Do**

- In the **backend** terminal, **Ctrl+C** to stop Express.
- Refresh the dashboard: requests may fail briefly—say that out loud.
- Start the API again: `cd backend && node index.js`.
- Refresh the dashboard: **all previous jobs** still appear with correct status, attempts, and results.

**Say**

> “The API process is **stateless** regarding job history: everything lives in **Postgres**. Restarting Express does not wipe the queue state we already processed or the rows we already wrote. That’s why this is a **distributed systems** demo—not a single long-lived script holding jobs in RAM.”

---

## Quick checklist (demo day)

| # | Check |
|---|--------|
| 1 | `docker ps` — Redis + Postgres healthy |
| 2 | Backend listening **5050** |
| 3 | At least one worker connected to Redis |
| 4 | Next dev server **3000**, dashboard loads |
| 5–7 | One `data_processing` + logs + details |
| 8 | `report_generation` + `email_batch` + files on disk |
| 9 | Mention simulated failure + retries / `maxAttempts` |
| 10 | Low / normal / high ordering visible |
| 11 | Load test 200 / 25 with **one** worker |
| 12 | **Three** workers, repeat load test, compare time |
| 13 | Kill backend, restart, refresh — data still there |

**Closing line (optional)**

> “We separated **submission**, **persistence**, **queueing**, and **execution**, then scaled consumers and proved durability across API restarts—that’s the core of a small but real **distributed task scheduling platform**.”
