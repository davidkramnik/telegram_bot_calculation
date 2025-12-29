import "dotenv/config";
import { Bot, Keyboard, InlineKeyboard, InputFile } from "grammy";
import { MongoClient } from "mongodb";
import { chromium } from "playwright";
import { PDFDocument } from "pdf-lib";
import fs from "node:fs/promises";
import path from "node:path";

const TIMEZONE = process.env.TIMEZONE || "UTC";
const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB || "calculation_bot";

const bot = new Bot(process.env.BOT_TOKEN);

let botUsername = "";
let calculationCollections = {
  client: null,
  db: null,
  balances: null,
  balanceEvents: null,
  balanceAdmins: null,
};
const pdfDateRequests = new Map();
bot.api
  .getMe()
  .then((me) => {
    botUsername = me.username ?? "";
    console.log(`Bot username: ${botUsername}`);
  })
  .catch((err) => {
    console.error("Failed to fetch bot info", err);
  });

bot.catch((err) => {
  const ctx = err.ctx;
  const e = err.error;
  if (e?.error_code === 429 && e?.parameters?.retry_after) {
    console.warn(
      `Rate limited in chat ${ctx?.chat?.id ?? ""}. Retry after ${e.parameters.retry_after}s`
    );
    return;
  }
  console.error("Unhandled bot error", err);
});

// Helper: allow group only
function ensureGroup(ctx) {
  const type = ctx.chat?.type;
  if (type === "private") {
    ctx.reply(withMention(ctx, "Please use this command in a group 🙂"));
    return false;
  }
  return true;
}

// /start
bot.command("start", async (ctx) => {
  await ctx.reply(withMention(ctx, "Hi! Try /help or /menu"));
});

// /help
bot.command("help", async (ctx) => {
  await ctx.reply(
withMention(ctx, `Commands:
- /result <number>     (example: /result 21)
- /menu                (interactive buttons)
- /calculation          (show report buttons)
- /report              (full report)
- /setbalanceadmin      (assign who can use + / - balance)
- /pdf                  (PDF by date, DDMMYYYY)
- /ping
- Balance update: /balance +number or /balance -number (example: /balance +10000)
- Buttons: View Report shows last 6 entries; View Report (PDF) sends full report
`)
  );
});

// /ping
bot.command("ping", (ctx) => ctx.reply(withMention(ctx, "pong ✅")));

// /result <number>
bot.command("result", async (ctx) => {
  if (!ensureGroup(ctx)) return;

  const text = ctx.message?.text ?? "";
  const arg = text.split(" ").slice(1).join(" ").trim();

  if (!arg) return ctx.reply(withMention(ctx, "Usage: /result <number>\nExample: /result 21"));

  const n = Number(arg);
  if (Number.isNaN(n)) return ctx.reply(withMention(ctx, `"${arg}" is not a number.`));

  // Your real business logic goes here
  const result = n * 2;

  await ctx.reply(withMention(ctx, `Result: ${result}`));
});

// /menu with inline buttons
bot.command("menu", async (ctx) => {
  if (!ensureGroup(ctx)) return;

  const kb = new InlineKeyboard()
    .text("Double 10", "double:10")
    .text("Double 25", "double:25")
    .row()
    .text("Help", "help");

  await ctx.reply(withMention(ctx, "Choose an action:"), { reply_markup: kb });
});

// Button callbacks
bot.callbackQuery(/^double:(\d+)$/, async (ctx) => {
  const num = Number(ctx.match[1]);
  const result = num * 2;

  await ctx.answerCallbackQuery();
  await ctx.reply(withMention(ctx, `Result: ${result}`));
});

bot.callbackQuery("help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(withMention(ctx, "Try /result 21 or /menu"));
});

const replyKeyboard = new Keyboard()
  .text("View Report")
  .text("📄 View Report (PDF)")
  .row()
  .text("📄 Report PDF by Date")
  .resized()
  .persistent();

function mentionUser(ctx) {
  if (ctx.from?.username) return `@${ctx.from.username}`;
  const name = `${ctx.from?.first_name ?? ""} ${ctx.from?.last_name ?? ""}`.trim();
  return name || "User";
}

function mentionUserByUser(user) {
  if (user?.username) return `@${user.username}`;
  const name = `${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim();
  return name || "User";
}

function withMention(ctx, message) {
  return `${mentionUser(ctx)} ${message}`;
}

async function ensureDb() {
  if (calculationCollections.balanceEvents) return calculationCollections;
  if (!MONGO_URI) {
    throw new Error("MONGO_URI is not set. Please set it in .env");
  }
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  calculationCollections = {
    client,
    db,
    balances: db.collection("user_balances"),
    balanceEvents: db.collection("balance_events"),
    balanceAdmins: db.collection("balance_admins"),
  };
  await calculationCollections.balances.createIndex(
    { chat_id: 1, user_id: 1 },
    { unique: true }
  );
  await calculationCollections.balanceEvents.createIndex({ chat_id: 1, timestamp: 1 });
  await calculationCollections.balanceEvents.createIndex({ user_id: 1, timestamp: 1 });
  await calculationCollections.balanceAdmins.createIndex({ chat_id: 1 }, { unique: true });
  return calculationCollections;
}

function formatTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatAmount(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return "0";
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

function formatAmountWithCommas(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return "0";
  const formatter = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: Number.isInteger(num) ? 0 : 2,
    maximumFractionDigits: 2,
  });
  return formatter.format(num);
}

function displayMemberId(event) {
  if (event.username) return event.username;
  if (event.user_id) return String(event.user_id);
  return "unknown";
}

function formatSignedAmount(n) {
  const num = Number(n);
  const sign = num >= 0 ? "+" : "-";
  const abs = Math.abs(num);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  return `${sign}${body}`;
}

function formatSignedAmountWithCommas(n) {
  const num = Number(n);
  const sign = num >= 0 ? "+" : "-";
  return `${sign}${formatAmountWithCommas(Math.abs(num))}`;
}

function formatDateDMY(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function parseDDMMYYYY(value) {
  const match = value.match(/^(\d{2})(\d{2})(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const test = new Date(year, month - 1, day);
  if (
    test.getFullYear() !== year ||
    test.getMonth() !== month - 1 ||
    test.getDate() !== day
  ) {
    return null;
  }
  return { day, month, year };
}

function buildDateRangeFromDDMMYYYY(value) {
  const parsed = parseDDMMYYYY(value);
  if (!parsed) return null;
  const display = `${String(parsed.day).padStart(2, "0")}/${String(parsed.month).padStart(
    2,
    "0"
  )}/${parsed.year}`;
  return {
    display,
    label: `${parsed.day}${String(parsed.month).padStart(2, "0")}${parsed.year}`,
  };
}

function getTodayLabelInTimezone() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(new Date());
  const values = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = part.value;
  }
  return `${values.day}${values.month}${values.year}`;
}

async function fetchBalanceEvents(chatId, { start, end, dayLabel } = {}) {
  const { balanceEvents } = await ensureDb();
  if (dayLabel) {
    return balanceEvents
      .aggregate([
        { $match: { chat_id: chatId } },
        {
          $addFields: {
            day_label: {
              $dateToString: {
                format: "%d%m%Y",
                date: "$timestamp",
                timezone: TIMEZONE,
              },
            },
          },
        },
        { $match: { day_label: dayLabel } },
        { $sort: { timestamp: 1 } },
      ])
      .toArray();
  }
  const query = { chat_id: chatId };
  if (start || end) {
    query.timestamp = {};
    if (start) query.timestamp.$gte = start;
    if (end) query.timestamp.$lt = end;
  }
  return balanceEvents.find(query).sort({ timestamp: 1 }).toArray();
}

function padRight(value, width) {
  const text = String(value);
  if (text.length >= width) return text.slice(0, width);
  return text.padEnd(width, " ");
}

function buildReportEntryLineText(event) {
  const member = padRight(displayMemberId(event), 9);
  return `${member} ⏱️ ${formatTime(event.timestamp)}  ${formatSignedAmountWithCommas(
    event.delta
  )}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function buildPdfHtml(events, { useTemplate = false } = {}) {
  const total = events.reduce((sum, e) => sum + (Number(e.delta) || 0), 0);
  const reportDate = formatDateDMY(new Date());
  const logoPath = path.join(process.cwd(), "backgroundlogo.jpg");
  const rows = events
    .map((e) => {
      const member = escapeHtml(displayMemberId(e));
      const time = escapeHtml(formatTime(e.timestamp));
      const amount = formatSignedAmountWithCommas(e.delta);
      const amountClass = amount.startsWith("+") ? "pos" : "neg";
      return `<div class="row"><span class="member">${member}</span><span class="time">⏱️ ${time}</span><span class="amount ${amountClass}">${escapeHtml(amount)}</span></div>`;
    })
    .join("");

  const perMember = new Map();
  for (const e of events) {
    const key = displayMemberId(e);
    if (!perMember.has(key)) {
      perMember.set(key, { entries: 0, total: 0 });
    }
    const entry = perMember.get(key);
    entry.entries += 1;
    entry.total += Number(e.delta) || 0;
  }
  const memberBlocks = Array.from(perMember.entries())
    .map(([member, stats], idx) => {
      const name = escapeHtml(member);
      return `<div class="member-block">
  <div class="member-title">${idx + 1}. ${name}</div>
  <div>Total entries : ${stats.entries}</div>
  <div>Total amount : ${escapeHtml(formatAmountWithCommas(stats.total))}</div>
</div>`;
    })
    .join("");

  const emojiFontPath = path.join(process.cwd(), "fonts", "NotoColorEmoji-Regular.ttf");
  const emojiFontCss = `@font-face { font-family: "NotoColorEmoji"; src: url("file://${emojiFontPath}"); }`;

  let logoDataUri = "";
  try {
    const logoBuffer = await fs.readFile(logoPath);
    logoDataUri = `data:image/jpeg;base64,${logoBuffer.toString("base64")}`;
  } catch {
    logoDataUri = "";
  }

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      ${emojiFontCss}
      body {
        font-family: "Courier New", Courier, monospace;
        font-size: 12px;
        font-weight: 700;
        margin: 24px;
        color: #222;
        background: ${useTemplate ? "transparent" : "#fff"};
      }
      * {
        font-weight: 700;
      }
      body::before {
        content: "";
        position: fixed;
        inset: 0;
        background: ${
          !useTemplate && logoDataUri
            ? `url("${logoDataUri}") center/80% no-repeat`
            : "none"
        };
        opacity: 0.2;
        z-index: -1;
      }
      .row {
        display: grid;
        grid-template-columns: 120px 120px 120px;
        column-gap: 12px;
        line-height: 1.3;
      }
      .member {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .time {
        white-space: nowrap;
      }
      .amount {
        text-align: right;
      }
      .pos { color: #1b7f2a; }
      .neg { color: #b3261e; }
      .separator {
        border-top: 1px solid #444;
        margin: 8px 0;
      }
      .title {
        font-family: "NotoColorEmoji", "Courier New", monospace;
        margin: 0 0 6px 0;
      }
      .date {
        font-family: "NotoColorEmoji", "Courier New", monospace;
        margin: 0 0 6px 0;
      }
      .total {
        font-family: "NotoColorEmoji", "Courier New", monospace;
        margin: 6px 0 12px 0;
      }
      .members-title {
        font-family: "NotoColorEmoji", "Courier New", monospace;
        margin: 10px 0 6px 0;
      }
      .member-block { margin: 6px 0 10px 0; }
    </style>
  </head>
  <body>
    <div class="title">📊 TRANSACTION LOG</div>
    <div class="date">📅 ${escapeHtml(reportDate)}</div>
    <div class="separator"></div>
    ${rows}
    <div class="separator"></div>
    <div class="total">💵 TOTAL: ${escapeHtml(formatAmountWithCommas(total))}</div>
    <div class="members-title">👥 Members Daily report</div>
    ${memberBlocks}
  </body>
</html>`;
}

async function renderReportPdf(events) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const html = await buildPdfHtml(events, { useTemplate: true });
  await page.setContent(html, { waitUntil: "networkidle" });
  const buffer = await page.pdf({
    format: "A4",
    printBackground: true,
    omitBackground: true,
  });
  await browser.close();
  const templatePath = path.join(process.cwd(), "report_template.pdf");
  let templateBuffer;
  try {
    templateBuffer = await fs.readFile(templatePath);
  } catch (err) {
    console.warn("Template PDF not found, using default report PDF.", err);
    return buffer;
  }

  const templateDoc = await PDFDocument.load(templateBuffer);
  const contentDoc = await PDFDocument.load(buffer);
  const outputDoc = await PDFDocument.create();
  const templatePageCount = templateDoc.getPageCount();
  const contentPageCount = contentDoc.getPageCount();
  if (!templatePageCount) return buffer;

  for (let i = 0; i < contentPageCount; i += 1) {
    const templateIndex = Math.min(i, templatePageCount - 1);
    const [templatePage] = await outputDoc.copyPages(templateDoc, [templateIndex]);
    const [contentPage] = await outputDoc.copyPages(contentDoc, [i]);
    const outputPage = outputDoc.addPage(templatePage);
    const { width, height } = outputPage.getSize();
    const embeddedContent = await outputDoc.embedPage(contentPage);
    outputPage.drawPage(embeddedContent, { x: 0, y: 0, width, height });
  }

  return Buffer.from(await outputDoc.save());
}


function resolveBalanceTarget(ctx) {
  const repliedUser = ctx.message?.reply_to_message?.from;
  if (repliedUser?.id) {
    return repliedUser;
  }
  return ctx.from;
}

async function updateUserBalance(ctx, delta, targetUser = ctx.from) {
  const chatId = ctx.chat?.id;
  const userId = targetUser?.id;
  if (!chatId || !userId) {
    throw new Error("Missing chat or user info.");
  }
  const { balances, balanceEvents } = await ensureDb();
  const result = await balances.findOneAndUpdate(
    { chat_id: chatId, user_id: userId },
    {
      $inc: { balance: delta },
      $setOnInsert: {
        chat_id: chatId,
        user_id: userId,
        username: targetUser?.username,
        name: `${targetUser?.first_name ?? ""} ${targetUser?.last_name ?? ""}`.trim(),
        created_at: new Date(),
      },
      $set: { updated_at: new Date() },
    },
    { upsert: true, returnDocument: "after" }
  );
  const updated = result.value;
  await balanceEvents.insertOne({
    chat_id: chatId,
    chat_title: ctx.chat?.title,
    user_id: userId,
    username: targetUser?.username,
    name: `${targetUser?.first_name ?? ""} ${targetUser?.last_name ?? ""}`.trim(),
    timestamp: new Date(),
    delta,
    balance: updated?.balance ?? delta,
    updated_by: ctx.from?.id,
  });
  return result.value;
}

async function getBalanceAdmin(chatId) {
  const { balanceAdmins } = await ensureDb();
  return balanceAdmins.findOne({ chat_id: chatId });
}

async function ensureBalanceAdmin(ctx) {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) {
    await ctx.reply(withMention(ctx, "Missing chat or user info."));
    return false;
  }
  const admin = await getBalanceAdmin(chatId);
  if (!admin?.user_id) {
    await ctx.reply(withMention(ctx, "Balance admin not set. Use /setbalanceadmin as a chat admin."));
    return false;
  }
  if (String(admin.user_id) !== String(userId)) {
    await ctx.reply(withMention(ctx, "Only the balance admin can update balances."));
    return false;
  }
  return true;
}

// Reply keyboard labels
function buildReportLines(events, { limit, entryFormatter, style = "pretty" } = {}) {
  const total = events.reduce((sum, e) => sum + (Number(e.delta) || 0), 0);
  const reportDate = formatDateDMY(new Date());
  const displayEvents = limit ? events.slice(-limit) : events;
  const formatEntry = entryFormatter || buildReportEntryLineText;
  const separator = style === "pretty" ? "────────────────" : "----------";
  const header = style === "pretty" ? "📊 TRANSACTION LOG" : "TRANSACTION LOG";
  const dateLine = style === "pretty" ? `📅 ${reportDate}` : `Date: ${reportDate}`;
  const totalLabel = style === "pretty" ? "💵 TOTAL:" : "TOTAL:";
  const totalValue =
    style === "pretty" ? formatAmountWithCommas(total) : formatAmount(total);
  const lines = [header, "", dateLine, separator];
  for (const e of displayEvents) {
    lines.push(formatEntry(e));
  }
  lines.push(separator, `${totalLabel} ${totalValue}`);
  return { lines, total };
}

async function sendReport(ctx, { limit, asPdf, mentionPrefix } = {}) {
  if (!ensureGroup(ctx)) return;
  const chatId = ctx.chat?.id;
  const todayLabel = getTodayLabelInTimezone();
  const events = await fetchBalanceEvents(chatId, { dayLabel: todayLabel });

  const { lines } = buildReportLines(events, {
    limit,
    entryFormatter: buildReportEntryLineText,
    style: "pretty",
  });
  if (asPdf) {
    const buffer = await renderReportPdf(events);
    await ctx.replyWithDocument(new InputFile(buffer, "report.pdf"), {
      caption: mentionPrefix ? withMention(ctx, mentionPrefix) : undefined,
    });
    return;
  }
  const text = lines.join("\n");
  const prefix = mentionPrefix ? `${withMention(ctx, mentionPrefix)}\n` : "";
  const html = `<pre><b>${escapeHtml(prefix + text)}</b></pre>`;
  await ctx.reply(html, { reply_markup: replyKeyboard, parse_mode: "HTML" });
}

bot.hears(["View Report", "Vew Report", "🌐 Full Report"], async (ctx) => {
  await sendReport(ctx, { limit: 6 });
});

bot.hears(["📄 View Report (PDF)", "View Report (PDF)"], async (ctx) => {
  await sendReport(ctx, { asPdf: true });
});

bot.hears("📄 Report PDF by Date", async (ctx) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (chatId && userId) {
    pdfDateRequests.set(`${chatId}:${userId}`, Date.now());
  }
  await ctx.reply(withMention(ctx, "Send the date as DDMMYYYY (example: 27122025)"));
});

bot.on("message:text", async (ctx, next) => {
  const chatId = ctx.chat?.id;
  const userId = ctx.from?.id;
  if (!chatId || !userId) return next();
  const key = `${chatId}:${userId}`;
  const requestedAt = pdfDateRequests.get(key);
  if (!requestedAt) return next();
  if (Date.now() - requestedAt > 5 * 60 * 1000) {
    pdfDateRequests.delete(key);
    return next();
  }

  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();
  if (text === "*" || text === "**") return next();
  const range = buildDateRangeFromDDMMYYYY(text);
  if (!range) {
    await ctx.reply(withMention(ctx, "Invalid date. Use DDMMYYYY (example: 27122025)."));
    return;
  }
  pdfDateRequests.delete(key);
  const events = await fetchBalanceEvents(chatId, {
    dayLabel: range.label,
  });
  if (!events.length) {
    await ctx.reply(withMention(ctx, "No entries for that date."));
    return;
  }
  const buffer = await renderReportPdf(events);
  await ctx.replyWithDocument(new InputFile(buffer, `report-${range.label}.pdf`), {
    caption: withMention(ctx, `Report for ${range.display}`),
  });
});


bot.command("calculation", async (ctx) => {
  if (!ensureGroup(ctx)) return;
  await ctx.reply(withMention(ctx, "Tap a button to view the report:"), {
    reply_markup: replyKeyboard,
  });
});

bot.command("setbalanceadmin", async (ctx) => {
  if (!ensureGroup(ctx)) return;
  const chatId = ctx.chat?.id;
  const fromId = ctx.from?.id;
  if (!chatId || !fromId) return;

  try {
    const member = await ctx.api.getChatMember(chatId, fromId);
    const isAdmin =
      member.status === "creator" || member.status === "administrator";
    if (!isAdmin) {
      await ctx.reply(withMention(ctx, "Only chat admins can set the balance admin."));
      return;
    }
  } catch (err) {
    console.error("Failed to verify admin status", err);
    await ctx.reply(withMention(ctx, "Could not verify admin status. Please try again."));
    return;
  }

  let target = null;
  if (ctx.message?.reply_to_message?.from?.id) {
    target = ctx.message.reply_to_message.from;
  } else if (ctx.message?.entities) {
    const mention = ctx.message.entities.find((e) => e.type === "text_mention");
    if (mention?.user) target = mention.user;
  }

  const text = ctx.message?.text ?? "";
  const arg = text.split(" ").slice(1).join(" ").trim();
  const argId = arg && /^\d+$/.test(arg) ? Number(arg) : null;
  const targetId = target?.id ?? argId;
  if (!targetId) {
    await ctx.reply(withMention(ctx, "Reply to a user's message or use /setbalanceadmin <user_id>."));
    return;
  }

  const { balanceAdmins } = await ensureDb();
  await balanceAdmins.updateOne(
    { chat_id: chatId },
    {
      $set: {
        chat_id: chatId,
        user_id: targetId,
        username: target?.username,
        name: `${target?.first_name ?? ""} ${target?.last_name ?? ""}`.trim(),
        updated_at: new Date(),
        updated_by: fromId,
      },
    },
    { upsert: true }
  );
  await ctx.reply(withMention(ctx, `Balance admin set to ${target?.username ?? targetId}.`));
});

bot.command("pdf", async (ctx) => {
  if (!ensureGroup(ctx)) return;
  const text = ctx.message?.text ?? "";
  const arg = text.split(" ").slice(1).join(" ").trim();
  if (!arg) {
    await ctx.reply(withMention(ctx, "Usage: /pdf DDMMYYYY (example: /pdf 27122025)"));
    return;
  }
  const range = buildDateRangeFromDDMMYYYY(arg);
  if (!range) {
    await ctx.reply(withMention(ctx, "Invalid date. Use DDMMYYYY (example: /pdf 27122025)."));
    return;
  }
  const chatId = ctx.chat?.id;
  const events = await fetchBalanceEvents(chatId, {
    dayLabel: range.label,
  });
  if (!events.length) {
    await ctx.reply(withMention(ctx, "No entries for that date."));
    return;
  }
  const buffer = await renderReportPdf(events);
  await ctx.replyWithDocument(new InputFile(buffer, `report-${range.label}.pdf`), {
    caption: withMention(ctx, `Report for ${range.display}`),
  });
});

bot.command("balance", async (ctx) => {
  if (!ensureGroup(ctx)) return;
  if (!(await ensureBalanceAdmin(ctx))) return;
  const text = ctx.message?.text ?? "";
  const arg = text.split(" ").slice(1).join(" ").trim();
  if (!arg) {
    await ctx.reply(withMention(ctx, "Usage: /balance +number or /balance -number (example: /balance +10000)"));
    return;
  }
  const match = arg.match(/^([+-]\d+(?:\.\d+)?)$/);
  if (!match) {
    await ctx.reply(withMention(ctx, "Please provide a signed number. Example: /balance +10000"));
    return;
  }

  const delta = Number(match[1]);
  if (Number.isNaN(delta)) {
    await ctx.reply(withMention(ctx, "That number is not valid."));
    return;
  }

  try {
    const targetUser = resolveBalanceTarget(ctx);
    await updateUserBalance(ctx, delta, targetUser);
    await sendReport(ctx, { limit: 6, mentionPrefix: "Balance updated." });
  } catch (err) {
    console.error("Failed to update balance", err);
    await ctx.reply(withMention(ctx, "Could not update balance right now. Please try again."));
  }
});

bot.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();
  if (text !== "*" && text !== "**") return next();
  if (!ensureGroup(ctx)) return;
  if (!(await ensureBalanceAdmin(ctx))) return;
  const target = ctx.message.reply_to_message?.from;
  if (!target?.id) {
    await ctx.reply(withMention(ctx, "Reply to a member's message with * or **."));
    return;
  }
  const notice =
    text === "**"
      ? "<b>⚠️ This payment has not yet received.</b>"
      : "<b>⚠️ This transaction has failed.</b>";
  await ctx.reply(`${mentionUserByUser(target)} ${notice}`, { parse_mode: "HTML" });
});

// Balance adjustments: +number or -number (requires privacy mode disabled)
bot.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();
  const cleaned = botUsername ? text.replace(`@${botUsername}`, "").trim() : text;
  const match = cleaned.match(/^([+-]\d+(?:\.\d+)?)$/);
  if (!match) return next();
  if (!ensureGroup(ctx)) return;
  if (!(await ensureBalanceAdmin(ctx))) return;

  const delta = Number(match[1]);
  if (Number.isNaN(delta)) return next();

  try {
    const targetUser = resolveBalanceTarget(ctx);
    await updateUserBalance(ctx, delta, targetUser);
    await sendReport(ctx, { limit: 6 });
  } catch (err) {
    console.error("Failed to update balance", err);
    await ctx.reply("Could not update balance right now. Please try again.");
  }
});

// Free text is allowed; keep only explicit commands and handlers.

// Calculation report
bot.command("report", async (ctx) => {
  await sendReport(ctx, { mentionPrefix: "Here is your report." });
});

// Start polling
(async () => {
  try {
    await ensureDb();
    bot.start();
    console.log("Bot running (polling)...");
  } catch (err) {
    console.error("Failed to start bot", err);
    process.exit(1);
  }
})();
