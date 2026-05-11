"use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { createClient } = require("redis");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT ?? 5050);
const DATABASE_URL = process.env.DATABASE_URL;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const PRIORITIES = new Set(["low", "normal", "high"]);
const QUEUE_KEYS = {
  high: "job_queue_high",
  normal: "job_queue_normal",
  low: "job_queue_low",
};

function normalizePriorityFromRow(raw) {
  if (typeof raw === "string" && PRIORITIES.has(raw)) return raw;
  return "normal";
}

/** POST body: omitted → normal; invalid explicit value → null. */
function parsePriorityFromBody(body) {
  if (body?.priority === undefined || body?.priority === null) {
    return "normal";
  }
  if (typeof body.priority === "string" && PRIORITIES.has(body.priority)) {
    return body.priority;
  }
  return null;
}

function redisQueueKeyForPriority(priority) {
  return QUEUE_KEYS[priority] ?? QUEUE_KEYS.normal;
}

app.use(cors());
app.use(express.json());

const TASK_TYPES = new Set([
  "report_generation",
  "data_processing",
  "email_batch",
]);

const STATUSES = new Set(["pending", "running", "completed", "failed"]);

function jobToJson(job) {
  return {
    id: job.id,
    type: job.type ?? null,
    status: job.status ?? "pending",
    priority: normalizePriorityFromRow(job.priority),
    createdAt: job.created_at,
    result: job.result !== undefined ? job.result : null,
    attempts: typeof job.attempts === "number" ? job.attempts : 0,
    maxAttempts: typeof job.max_attempts === "number" ? job.max_attempts : 3,
    error: typeof job.error === "string" ? job.error : null,
  };
}

if (!DATABASE_URL) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const db = new Pool({ connectionString: DATABASE_URL });
const redis = createClient({ url: REDIS_URL });

redis.on("error", (err) => {
  console.error("Redis error:", err.message);
});

app.post("/jobs", async (req, res) => {
  const rawType = req.body?.type;
  if (typeof rawType !== "string" || !TASK_TYPES.has(rawType)) {
    return res.status(400).json({
      error: "Invalid or missing type",
      allowed: [...TASK_TYPES],
    });
  }

  const { v4: uuidv4 } = await import("uuid");
  const priority = parsePriorityFromBody(req.body);
  if (priority === null) {
    return res.status(400).json({
      error: "Invalid priority",
      allowed: [...PRIORITIES],
    });
  }
  const job = {
    id: uuidv4(),
    type: rawType,
    status: "pending",
    priority,
    created_at: new Date().toISOString(),
    result: null,
    attempts: 0,
    max_attempts: 3,
    error: null,
  };

  try {
    await db.query(
      `
      INSERT INTO jobs (id, type, status, priority, created_at, result, attempts, max_attempts, error)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `,
      [
        job.id,
        job.type,
        job.status,
        job.priority,
        job.created_at,
        job.result,
        job.attempts,
        job.max_attempts,
        job.error,
      ],
    );
  } catch (err) {
    console.error("Postgres insert failed:", err.message);
    return res.status(503).json({ error: "Database unavailable" });
  }

  try {
    await redis.rPush(redisQueueKeyForPriority(job.priority), job.id);
  } catch (err) {
    await db.query("DELETE FROM jobs WHERE id = $1", [job.id]).catch(() => {});
    console.error("Redis rPush failed:", err.message);
    return res.status(503).json({ error: "Queue unavailable" });
  }

  res.status(201).json(jobToJson(job));
});

app.get("/jobs", async (req, res) => {
  try {
    const result = await db.query(
      `
      SELECT id, type, status, priority, created_at, result, attempts, max_attempts, error
      FROM jobs
      ORDER BY created_at DESC
      `,
    );
    res.json(result.rows.map(jobToJson));
  } catch (err) {
    console.error("Postgres select failed:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});

app.patch("/jobs/:id", async (req, res) => {
  const hasStatus = "status" in req.body;
  const hasResult = "result" in req.body;
  const hasAttempts = "attempts" in req.body;
  const hasError = "error" in req.body;
  if (!hasStatus && !hasResult && !hasAttempts && !hasError) {
    return res.status(400).json({
      error: "Nothing to update",
      fields: ["status", "result", "attempts", "error"],
    });
  }

  const updates = [];
  const values = [];
  let idx = 1;

  if (hasStatus) {
    const s = req.body.status;
    if (typeof s !== "string" || !STATUSES.has(s)) {
      return res.status(400).json({
        error: "Invalid status",
        allowed: [...STATUSES],
      });
    }
    updates.push(`status = $${idx++}`);
    values.push(s);
  }

  if (hasResult) {
    updates.push(`result = $${idx++}`);
    values.push(req.body.result);
  }

  if (hasAttempts) {
    const attempts = req.body.attempts;
    if (!Number.isInteger(attempts) || attempts < 0) {
      return res.status(400).json({ error: "Invalid attempts" });
    }
    updates.push(`attempts = $${idx++}`);
    values.push(attempts);
  }

  if (hasError) {
    const error = req.body.error;
    if (error !== null && typeof error !== "string") {
      return res.status(400).json({ error: "Invalid error" });
    }
    updates.push(`error = $${idx++}`);
    values.push(error);
  }

  values.push(req.params.id);

  try {
    const result = await db.query(
      `
      UPDATE jobs
      SET ${updates.join(", ")}
      WHERE id = $${idx}
      RETURNING id, type, status, priority, created_at, result, attempts, max_attempts, error
      `,
      values,
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Job not found" });
    }

    res.json(jobToJson(result.rows[0]));
  } catch (err) {
    console.error("Postgres update failed:", err.message);
    res.status(503).json({ error: "Database unavailable" });
  }
});

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'normal',
      created_at TIMESTAMPTZ NOT NULL,
      result JSONB,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      error TEXT
    )
  `);
  await db.query(`
    ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal'
  `);
}

async function main() {
  await ensureSchema();
  console.log("Postgres connected and jobs table ready");

  await redis.connect();
  console.log(`Redis connected (${REDIS_URL})`);

  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
