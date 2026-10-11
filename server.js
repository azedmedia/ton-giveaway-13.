
require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
const { Address } = require("@ton/core");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const LIMIT = 13;
const REWARD = "0.052 TON";

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
app.use(express.static(path.join(__dirname, "public")));

const dataDir = path.join(__dirname, "data");
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, "giveaway.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.get("/api/status", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) AS count FROM claims").get().count;

  res.json({
    claimed: count,
    total: LIMIT,
    remaining: Math.max(0, LIMIT - count),
    full: count >= LIMIT,
    reward: REWARD
  });
});

async function notifyTelegram(address, slot) {
  const token = process.env.BOT_TOKEN;
  const chatId = process.env.ADMIN_CHAT_ID;

  if (!token || !chatId) {
    console.error("Telegram notification is not configured. Check BOT_TOKEN and ADMIN_CHAT_ID.");
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

app.post("/api/claim", (req, res) => {
  const raw =
    typeof req.body?.address === "string"
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

  const claim = db.transaction((address) => {
    const existing = db
      .prepare("SELECT id FROM claims WHERE address = ?")
      .get(address);

    if (existing) {
      return { type: "duplicate" };
    }

    const count = db
      .prepare("SELECT COUNT(*) AS count FROM claims")
      .get().count;

    if (count >= LIMIT) {
      return { type: "full" };
    }

    const result = db
      .prepare("INSERT INTO claims (address) VALUES (?)")
      .run(address);

    return {
      type: "accepted",
      slot: Number(result.lastInsertRowid)
    };
  });

  let outcome;

  try {
    outcome = claim.immediate(canonical);
  } catch (error) {
    console.error("Database error:", error.message);

    return res.status(500).json({
      error: "Something went wrong. Please try again shortly."
    });
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

  // Notify Telegram using the exact canonical address saved for this claim.
  notifyTelegram(canonical, outcome.slot).then((ok) => {
    if (!ok) {
      console.error(
        "Claim saved but Telegram notification needs checking. Slot:",
        outcome.slot
      );
    }
  });

  const count = db
    .prepare("SELECT COUNT(*) AS count FROM claims")
    .get().count;

  return res.status(201).json({
    success: true,
    slot: outcome.slot,
    total: LIMIT,
    remaining: Math.max(0, LIMIT - count),
    message: "Your wallet address has been submitted. Payouts are manual; no TON has been sent automatically."
  });
});

app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`TON giveaway running on port ${PORT}`);
});
