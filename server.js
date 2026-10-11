
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const { Pool } = require("pg");
const { Address } = require("@ton/core");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LIMIT = 13;
const REWARD = "0.052 TON";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is missing from environment variables.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"]
    }
  }
}));

app.use(express.json({ limit: "3kb" }));

app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

// Protect the admin page from public access.
app.get("/admin/claims", async (req, res) => {
  const username = process.env.ADMIN_USER;
  const password = process.env.ADMIN_PASSWORD;

  if (!username || !password) {
    return res.status(503).send(
      "Admin access is not configured in environment variables."
    );
  }

  const header = req.headers.authorization || "";
  const match = header.match(/^Basic\s+(.+)$/i);

  if (!match) {
    res.set("WWW-Authenticate", 'Basic realm="TON Claims"');
    return res.status(401).send("Admin login required.");
  }

  let supplied;
  try {
    supplied = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return res.status(401).send("Invalid login.");
  }

  const separator = supplied.indexOf(":");
  const suppliedUser = separator >= 0 ? supplied.slice(0, separator) : "";
  const suppliedPass = separator >= 0 ? supplied.slice(separator + 1) : "";

  const userOK = suppliedUser === username;
  const passOK = suppliedPass.length === password.length &&
    crypto.timingSafeEqual(
      Buffer.from(suppliedPass),
      Buffer.from(password)
    );

  if (!userOK || !passOK) {
    res.set("WWW-Authenticate", 'Basic realm="TON Claims"');
    return res.status(401).send("Incorrect username or password.");
  }

  try {
    const result = await pool.query(
      "SELECT id, address, created_at FROM claims ORDER BY id ASC"
    );

    res.set("Cache-Control", "no-store");
    return res.json({
      total: result.rowCount,
      claims: result.rows
    });
  } catch (error) {
    console.error("Claims retrieval failed:", error.message);
    return res.status(500).send("Could not retrieve claims.");
  }
});

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM claims"
    );
    const count = result.rows[0].count;

    res.json({
      claimed: count,
      total: LIMIT,
      remaining: Math.max(0, LIMIT - count),
      full: count >= LIMIT,
      reward: REWARD
    });
  } catch (error) {
    console.error("Status database error:", error.message);
    res.status(503).json({
      error: "Giveaway status temporarily unavailable."
    });
  }
});

async function notifyTelegram(address, slot) {
  const token = process.env.BOT_TOKEN;
  const chatId = process.env.ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.error("Telegram BOT_TOKEN or ADMIN_CHAT_ID is missing.");
    return false;
  }

  const message =
    "🎁 TON GIVEAWAY — NEW CLAIM\n\n" +
    "Slot: " + slot + "/" + LIMIT + "\n" +
    "Reward: " + REWARD + " (manual payout)\n" +
    "TON address:\n" + address + "\n\n" +
    "No payout was sent automatically.";

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message
        })
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error(
        "Telegram notification failed:",
        result.description || response.status
      );
      return false;
    }

    console.log("Telegram notification sent for slot:", slot);
    return true;
  } catch (error) {
    console.error("Telegram notification error:", error.message);
    return false;
  }
}

app.post("/api/claim", async (req, res) => {
  const raw = typeof req.body?.address === "string"
    ? req.body.address.trim()
    : "";

  if (!raw || raw.length > 100) {
    return res.status(400).json({
      error: "Enter a valid TON wallet address."
    });
  }

  let canonical;

  try {
    canonical = Address.parse(raw).toString({
      urlSafe: true,
      bounceable: true,
      testOnly: false
    });
  } catch {
    return res.status(400).json({
      error: "That doesn't look like a valid TON address. Check it and try again."
    });
  }

  let client;
  let outcome;

  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [130013]);

    const existing = await client.query(
      "SELECT id FROM claims WHERE address = $1",
      [canonical]
    );

    if (existing.rowCount > 0) {
      outcome = { type: "duplicate" };
    } else {
      const countResult = await client.query(
        "SELECT COUNT(*)::int AS count FROM claims"
      );

      if (countResult.rows[0].count >= LIMIT) {
        outcome = { type: "full" };
      } else {
        const inserted = await client.query(
          "INSERT INTO claims (address) VALUES ($1) RETURNING id",
          [canonical]
        );

        outcome = {
          type: "accepted",
          slot: Number(inserted.rows[0].id)
        };
      }
    }

    if (outcome.type === "accepted") {
      await client.query("COMMIT");
    } else {
      await client.query("ROLLBACK");
    }
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    console.error("Claim database error:", error.message);
    return res.status(500).json({
      error: "Something went wrong. Please try again shortly."
    });
  } finally {
    if (client) client.release();
  }

  if (outcome.type === "duplicate") {
    return res.status(409).json({
      error: "This TON wallet has already claimed a slot. Only one entry per wallet is allowed."
    });
  }

  if (outcome.type === "full") {
    return res.status(410).json({
      error: "Reward Fully Claimed",
      full: true
    });
  }

  // The claim is saved even if Telegram notification fails.
  notifyTelegram(canonical, outcome.slot).then(ok => {
    if (!ok) {
      console.error(
        "Claim saved but Telegram notification needs checking. Slot:",
        outcome.slot
      );
    }
  });

  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM claims"
    );
    const count = result.rows[0].count;

    return res.status(201).json({
      success: true,
      slot: outcome.slot,
      total: LIMIT,
      remaining: Math.max(0, LIMIT - count),
      message: "Your wallet address has been submitted. Payouts are manual; no TON has been sent automatically."
    });
  } catch (error) {
    console.error("Claim count error:", error.message);
    return res.status(201).json({
      success: true,
      slot: outcome.slot,
      total: LIMIT,
      message: "Your wallet address has been submitted. Payouts are manual; no TON has been sent automatically."
    });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS claims (
      id BIGSERIAL PRIMARY KEY,
      address TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  console.log("PostgreSQL connected and claims table ready.");

  app.listen(PORT, () => {
    console.log("TON giveaway running on port " + PORT);
  });
}

start().catch(error => {
  console.error("Server startup failed:", error.message);
  process.exit(1);
});
