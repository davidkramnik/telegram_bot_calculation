import "dotenv/config";
import { Bot, Keyboard, InlineKeyboard } from "grammy";
import { MongoClient } from "mongodb";
import fs from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_PATH = path.join(LOG_DIR, "attendance-log.jsonl");
const ALLOW_PLAIN_CODES = process.env.ALLOW_PLAIN_CODES !== "false";
const REQUIRE_MENTION = process.env.REQUIRE_MENTION === "true";
const TIMEZONE = process.env.TIMEZONE || "UTC";
const MONGO_URI = process.env.MONGO_URI;
const MONGO_DB = process.env.MONGO_DB || "attendance_bot";

const bot = new Bot(process.env.BOT_TOKEN);

let botUsername = "";
let botId = 0;
const chatDeletePermissions = new Map();
let attendanceCollections = { client: null, db: null, events: null, sessions: null };
bot.api
  .getMe()
  .then((me) => {
    botUsername = me.username ?? "";
    botId = me.id;
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
    ctx.reply("Please use this command in a group 🙂");
    return false;
  }
  return true;
}

// /start
bot.command("start", async (ctx) => {
  await ctx.reply("Hi! Try /help or /menu");
});

// /help
bot.command("help", async (ctx) => {
  await ctx.reply(
`Commands:
- /result <number>     (example: /result 21)
- /menu                (interactive buttons)
- /attendance          (buttons for check in/out/breaks)
- /report              (today + week summary)
- /ping
- Attendance in group: send 1 ✅, 0 ☑️, wc 🚾, mb 🍽️, f 🛍, l ❌, or h 🏥
- wc/mb act as start/stop toggles for breaks`
  );
});

// /ping
bot.command("ping", (ctx) => ctx.reply("pong ✅"));

// /result <number>
bot.command("result", async (ctx) => {
  if (!ensureGroup(ctx)) return;

  const text = ctx.message?.text ?? "";
  const arg = text.split(" ").slice(1).join(" ").trim();

  if (!arg) return ctx.reply("Usage: /result <number>\nExample: /result 21");

  const n = Number(arg);
  if (Number.isNaN(n)) return ctx.reply(`"${arg}" is not a number.`);

  // Your real business logic goes here
  const result = n * 2;

  await ctx.reply(`Result: ${result}`);
});

// /menu with inline buttons
bot.command("menu", async (ctx) => {
  if (!ensureGroup(ctx)) return;

  const kb = new InlineKeyboard()
    .text("Double 10", "double:10")
    .text("Double 25", "double:25")
    .row()
    .text("Help", "help");

  await ctx.reply("Choose an action:", { reply_markup: kb });
});

// Button callbacks
bot.callbackQuery(/^double:(\d+)$/, async (ctx) => {
  const num = Number(ctx.match[1]);
  const result = num * 2;

  await ctx.answerCallbackQuery();
  await ctx.reply(`Result: ${result}`);
});

bot.callbackQuery("help", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("Try /result 21 or /menu");
});

// Attendance
const attendanceLabels = {
  "1": "Check-In ✅",
  "0": "Check-Out ☑️",
  wc: "Break / Restroom 🚾",
  mb: "Meal Break 🍽️",
  f: "Outside for Food 🛍",
  l: "Official Leave ❌",
  h: "Medical / Hospital 🏥",
};
const attendanceCodes = new Set(Object.keys(attendanceLabels));
const breakCodes = new Set(["wc", "mb", "f"]);
let activeSessions = new Map();

const replyKeyboard = new Keyboard()
  .text("Check-In ✅")
  .text("Check-Out ☑️")
  .row()
  .text("Restroom 🚾")
  .text("Meal 🍽️")
  .row()
  .text("Food Outside 🛍")
  .text("Official Leave ❌")
  .row()
  .text("Hospital 🏥")
  .resized()
  .persistent();

const keyboardTextToCode = new Map([
  ["Check-In ✅", "1"],
  ["Check-Out ☑️", "0"],
  ["Restroom 🚾", "wc"],
  ["Meal 🍽️", "mb"],
  ["Food Outside 🛍", "f"],
  ["Official Leave ❌", "l"],
  ["Hospital 🏥", "h"],
]);

function isBotMentioned(text = "") {
  if (!REQUIRE_MENTION) return true;
  if (!botUsername) return false;
  return text.includes(`@${botUsername}`);
}

function mentionUser(ctx) {
  if (ctx.from?.username) return `@${ctx.from.username}`;
  const name = `${ctx.from?.first_name ?? ""} ${ctx.from?.last_name ?? ""}`.trim();
  return name || "User";
}

async function canDeleteInChat(ctx) {
  const chatId = ctx.chat?.id;
  if (!chatId || !botId) return false;
  if (chatDeletePermissions.has(chatId)) return chatDeletePermissions.get(chatId);
  try {
    const member = await ctx.api.getChatMember(chatId, botId);
    const can =
      member.status === "creator" ||
      (member.status === "administrator" && member.can_delete_messages !== false);
    chatDeletePermissions.set(chatId, can);
    return can;
  } catch (err) {
    console.warn("Could not check delete permission", err);
    chatDeletePermissions.set(chatId, false);
    return false;
  }
}

async function ensureDb() {
  if (attendanceCollections.events) return attendanceCollections;
  if (!MONGO_URI) {
    throw new Error("MONGO_URI is not set. Please set it in .env");
  }
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(MONGO_DB);
  attendanceCollections = {
    client,
    db,
    events: db.collection("attendance_events"),
    sessions: db.collection("active_sessions"),
  };
  await attendanceCollections.events.createIndex({ timestamp: 1 });
  await attendanceCollections.events.createIndex({ user_id: 1 });
  await attendanceCollections.sessions.createIndex({ user_id: 1 });
  return attendanceCollections;
}

async function logAttendance(event) {
  // Optional local backup log
  try {
    await fs.mkdir(LOG_DIR, { recursive: true });
    await fs.appendFile(LOG_PATH, JSON.stringify(event) + "\n", "utf8");
  } catch (err) {
    console.warn("Could not write local log", err);
  }

  const { events } = await ensureDb();
  const doc = {
    ...event,
    timestamp: new Date(event.timestamp),
    start: event.start ? new Date(event.start) : undefined,
    end: event.end ? new Date(event.end) : undefined,
  };
  await events.insertOne(doc);
}

async function fetchEventsSince(since) {
  const { events } = await ensureDb();
  const query = since ? { timestamp: { $gte: since } } : {};
  const docs = await events.find(query).toArray();
  return docs.map((d) => ({
    ...d,
    timestamp: d.timestamp instanceof Date ? d.timestamp.toISOString() : d.timestamp,
    start: d.start instanceof Date ? d.start.toISOString() : d.start,
    end: d.end instanceof Date ? d.end.toISOString() : d.end,
  }));
}

function nowInTimezone() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: TIMEZONE }));
}

function startOfToday() {
  const d = nowInTimezone();
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek() {
  const d = nowInTimezone();
  const day = d.getDay(); // 0 = Sun
  const diff = (day + 6) % 7; // days since Monday
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfMonth() {
  const d = nowInTimezone();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function summarize(events, since) {
  const filtered = events.filter((e) => {
    const d = new Date(e.timestamp);
    return !Number.isNaN(d.getTime()) && d >= since;
  });
  const perUser = new Map();

  for (const event of filtered) {
    const key = event.user_id ?? event.username ?? "unknown";
    if (!perUser.has(key)) {
      perUser.set(key, {
        name: event.name,
        username: event.username,
        user_id: event.user_id,
        counts: { "1": 0, "0": 0, wc: 0, mb: 0, f: 0, l: 0, h: 0 },
        durations: { wc: 0, mb: 0, f: 0 },
        last: event.timestamp,
      });
    }
    const entry = perUser.get(key);
    if (attendanceCodes.has(event.code)) {
      entry.counts[event.code] += 1;
    }
    if (breakCodes.has(event.code) && Number.isFinite(event.duration_ms)) {
      entry.durations[event.code] += event.duration_ms;
    }
    entry.last = event.timestamp;
  }

  return { total: filtered.length, perUser };
}

function formatUserLine(entry) {
  const who = entry.name?.trim() || entry.username || entry.user_id || "unknown";
  const counts = entry.counts;
  const parts = [];
  if (counts["1"]) parts.push(`in:${counts["1"]}`);
  if (counts["0"]) parts.push(`out:${counts["0"]}`);
  if (counts.wc) parts.push(`wc:${counts.wc}`);
  if (counts.mb) parts.push(`mb:${counts.mb}`);
  if (counts.f) parts.push(`food:${counts.f}`);
  if (counts.l) parts.push(`leave:${counts.l}`);
  if (counts.h) parts.push(`hospital:${counts.h}`);
  const wcDur = entry.durations?.wc || 0;
  const mbDur = entry.durations?.mb || 0;
  const fDur = entry.durations?.f || 0;
  if (wcDur) parts.push(`wc⏱${formatDuration(wcDur)}`);
  if (mbDur) parts.push(`mb⏱${formatDuration(mbDur)}`);
  if (fDur) parts.push(`food⏱${formatDuration(fDur)}`);
  const bucket = parts.length ? parts.join(" ") : "no actions";
  const last = entry.last ? `last ${formatTimestamp(entry.last)}` : "no time";
  return `- ${who}: ${bucket} (${last})`;
}

function formatSummary(title, summary) {
  if (summary.total === 0) return `${title}: no records yet.`;
  const lines = [`${title}: ${summary.total} records`];
  for (const entry of summary.perUser.values()) {
    lines.push(formatUserLine(entry));
  }
  return lines.join("\n");
}

function formatActiveSessions() {
  if (!activeSessions.size) return "Active breaks: none.";
  const lines = ["Active breaks:"];
  for (const [uid, session] of activeSessions.entries()) {
    const who = session.name?.trim() || session.username || uid;
    const label = attendanceLabels[session.type] || session.type;
    lines.push(`- ${who}: ${label} since ${formatTimestamp(session.start)}`);
  }
  return lines.join("\n");
}

async function buildTodayReportForUser(uid) {
  const events = await fetchEventsSince(startOfToday());
  const userEvents = events
    .filter((e) => String(e.user_id) === String(uid))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (userEvents.length === 0) return null;

  const checkIns = userEvents.filter((e) => e.code === "1");
  const checkOuts = userEvents.filter((e) => e.code === "0");
  const firstIn = checkIns.length ? new Date(checkIns[0].timestamp) : null;
  const lastOut = checkOuts.length ? new Date(checkOuts[checkOuts.length - 1].timestamp) : null;
  const workingMs = firstIn && lastOut ? lastOut - firstIn : 0;

  const counts = { wc: 0, mb: 0, f: 0 };
  const durations = { wc: 0, mb: 0, f: 0 };
  for (const e of userEvents) {
    if (counts[e.code] !== undefined) counts[e.code] += 1;
    if (breakCodes.has(e.code) && Number.isFinite(e.duration_ms)) {
      durations[e.code] += e.duration_ms;
    }
  }

  return {
    firstIn,
    lastOut,
    workingMs,
    counts,
    durations,
  };
}

async function buildMonthReportForUser(uid) {
  const events = await fetchEventsSince(startOfMonth());
  const userEvents = events
    .filter((e) => String(e.user_id) === String(uid))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  if (userEvents.length === 0) return null;

  const hospitalDates = [];
  const leaveDates = [];
  for (const e of userEvents) {
    if (e.code === "h") hospitalDates.push(formatDateShort(e.timestamp));
    if (e.code === "l") leaveDates.push(formatDateShort(e.timestamp));
  }

  return {
    hospitalDates,
    leaveDates,
  };
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return fmt.format(d).replace(",", "");
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (!hours && !minutes) parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatDurationLong(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hPart = hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "";
  const mPart = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return [hPart, mPart].filter(Boolean).join(" ").trim();
}

function formatDateShort(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(d);
}

async function loadActiveSessions() {
  try {
    const { sessions } = await ensureDb();
    const docs = await sessions.find({}).toArray();
    activeSessions = new Map(
      docs.map((d) => [
        String(d.user_id),
        {
          type: d.type,
          start: d.start instanceof Date ? d.start.toISOString() : d.start,
          name: d.name,
          username: d.username,
          chat_id: d.chat_id,
        },
      ])
    );
  } catch (err) {
    console.error("Failed to load active sessions from Mongo", err);
    activeSessions = new Map();
  }
}

async function upsertActiveSession(uid, session) {
  const { sessions } = await ensureDb();
  await sessions.updateOne(
    { user_id: uid },
    {
      $set: {
        user_id: uid,
        type: session.type,
        start: new Date(session.start),
        name: session.name,
        username: session.username,
        chat_id: session.chat_id,
      },
    },
    { upsert: true }
  );
}

async function deleteActiveSession(uid) {
  const { sessions } = await ensureDb();
  await sessions.deleteOne({ user_id: uid });
}

async function logBreakInterval({ code, label, start, end, duration_ms, ctx, via }) {
  const event = {
    timestamp: end,
    code,
    label,
    start,
    end,
    duration_ms,
    user_id: ctx.from?.id,
    username: ctx.from?.username,
    name: `${ctx.from?.first_name ?? ""} ${ctx.from?.last_name ?? ""}`.trim(),
    chat_id: ctx.chat?.id,
    chat_title: ctx.chat?.title,
    message_id: ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id,
    via,
  };
  await logAttendance(event);
  return event;
}

function endActiveSession(session) {
  const end = new Date();
  const startDate = new Date(session.start);
  const duration_ms = end - startDate;
  return {
    start: session.start,
    end: end.toISOString(),
    duration_ms,
    code: session.type,
    label: attendanceLabels[session.type] || session.type,
  };
}

async function closeSession(uid, ctx, via) {
  const session = activeSessions.get(uid);
  if (!session) return null;
  const closed = endActiveSession(session);
  try {
    await logBreakInterval({ ...closed, ctx, via });
  } catch (err) {
    console.error("Failed to log break interval", err);
  }
  activeSessions.delete(uid);
  await deleteActiveSession(uid);
  return closed;
}

async function handleAttendance(ctx, code, via) {
  if (!ensureGroup(ctx)) return;

  const text = ctx.message?.text ?? "";
  if (via !== "button" && !isBotMentioned(text)) {
    const mention = botUsername ? `@${botUsername}` : "the bot";
    await ctx.reply(`Please mention ${mention} or use /attendance buttons.`);
    return;
  }

  const label = attendanceLabels[code];
  const timestamp = new Date().toISOString();
  const formattedTimestamp = formatTimestamp(timestamp);

  // Auto-close any active break session on checkout so durations are captured
  if (code === "0") {
    const uid = ctx.from?.id ? String(ctx.from.id) : null;
    if (uid && activeSessions.has(uid)) {
      await closeSession(uid, ctx, via);
    }
  }

  // Toggle for break codes (wc/mb) to track durations
  if (breakCodes.has(code)) {
    const uid = ctx.from?.id ? String(ctx.from.id) : null;
    if (!uid) {
      await ctx.reply("Could not identify user.");
      return;
    }

    const existing = activeSessions.get(uid);
    if (existing && existing.type === code) {
      const closed = await closeSession(uid, ctx, via);
      const durationText = formatDuration(closed?.duration_ms ?? 0);
      await ctx.reply(`${mentionUser(ctx)} ${label} ended. Duration: ${durationText}.`, {
        reply_to_message_id: ctx.message?.message_id,
      });
      return;
    }

    // If another break is active, close it before starting the new one
    if (existing && existing.type !== code) {
      const closed = await closeSession(uid, ctx, via);
      const durationText = formatDuration(closed?.duration_ms ?? 0);
      await ctx.reply(
        `${mentionUser(ctx)} ended ${
          attendanceLabels[closed?.code] ?? closed?.code ?? "previous break"
        } (${durationText}). Starting ${label} now.`,
        { reply_to_message_id: ctx.message?.message_id }
      );
    } else {
      const startMsg =
        code === "f"
          ? `${mentionUser(ctx)} Outside for Food 🛍 started! Send the same again to end and back to work.`
          : code === "mb"
          ? `${mentionUser(ctx)} Meal Break 🍽️ started! Send the same again to end and back to work.`
          : `${mentionUser(ctx)} Break / Restroom 🚾 started! Send the same again to end and back to work.`;
      await ctx.reply(startMsg, {
        reply_to_message_id: ctx.message?.message_id,
      });
    }

    activeSessions.set(uid, {
      type: code,
      start: timestamp,
      name: `${ctx.from?.first_name ?? ""} ${ctx.from?.last_name ?? ""}`.trim(),
      username: ctx.from?.username,
      chat_id: ctx.chat?.id,
    });
    await upsertActiveSession(uid, activeSessions.get(uid));
    return;
  }

  const event = {
    timestamp,
    code,
    label,
    user_id: ctx.from?.id,
    username: ctx.from?.username,
    name: `${ctx.from?.first_name ?? ""} ${ctx.from?.last_name ?? ""}`.trim(),
    chat_id: ctx.chat?.id,
    chat_title: ctx.chat?.title,
    message_id: ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id,
    via,
  };

  try {
    await logAttendance(event);
  } catch (err) {
    console.error("Failed to log attendance", err);
    await ctx.reply("Could not log right now. Please try again.");
    return;
  }

  await ctx.reply(`${mentionUser(ctx)} ${label} noted at ${formattedTimestamp}`, {
    reply_to_message_id: ctx.message?.message_id,
  });

  // After check-out, send personal daily report
  if (code === "0") {
    const report = await buildTodayReportForUser(ctx.from?.id);
    const month = await buildMonthReportForUser(ctx.from?.id);
    if (report) {
      const who =
        ctx.from?.username ? `@${ctx.from.username}` : `${ctx.from?.first_name ?? "User"}`;
      const hospitalDates = month?.hospitalDates ?? [];
      const leaveDates = month?.leaveDates ?? [];
      const hospitalList = hospitalDates.length
        ? hospitalDates.map((d, i) => `${i + 1}. ${d}`).join(" ")
        : "—";
      const leaveList = leaveDates.length
        ? leaveDates.map((d, i) => `${i + 1}. ${d}`).join(" ")
        : "—";
      const lines = [
        `${who} today report:`,
        `Check-in: ${report.firstIn ? formatTimestamp(report.firstIn) : "—"}`,
        `Check-out: ${report.lastOut ? formatTimestamp(report.lastOut) : "—"}`,
        `Working hours: ${report.workingMs ? formatDurationLong(report.workingMs) : "—"}`,
        `Total wc: ${report.counts.wc} times, ${formatDurationLong(report.durations.wc)}`,
        `Total food outside: ${report.counts.f} times, ${formatDurationLong(report.durations.f)}`,
        `Total food: ${report.counts.mb} times, ${formatDurationLong(report.durations.mb)}`,
        "",
        `Total hospital this month: ${hospitalDates.length} times`,
        `Date: ${hospitalList}`,
        `Total leave this month: ${leaveDates.length} times`,
        `Date: ${leaveList}`,
      ];
      await ctx.reply(lines.join("\n"), {
        reply_to_message_id: ctx.message?.message_id,
      });
    }
  }
}

// Plain text codes (can be turned off via ALLOW_PLAIN_CODES=false)
bot.hears(/^(1|0|wc|mb|f|l|h)$/i, async (ctx) => {
  if (!ALLOW_PLAIN_CODES) return;
  const code = ctx.match[1].toLowerCase();
  await handleAttendance(ctx, code, "text");
});

// Reply keyboard labels
bot.hears(Array.from(keyboardTextToCode.keys()), async (ctx) => {
  const code = keyboardTextToCode.get(ctx.message.text.trim());
  if (!code) return;
  await handleAttendance(ctx, code, "keyboard");
});

bot.command("attendance", async (ctx) => {
  if (!ensureGroup(ctx)) return;
  await ctx.reply("Tap a button to log attendance:", {
    reply_markup: replyKeyboard,
  });
});

// Friendly fallback for bad attendance codes
bot.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next(); // let commands through
  const code = text.toLowerCase();
  if (attendanceCodes.has(code)) return next(); // already handled by hears
  if (!ensureGroup(ctx)) return;

  const hint =
    `${mentionUser(ctx)} Only attendance inputs are allowed here. Please use the buttons or send the short codes: 1 (Check-In ✅), 0 (Check-Out ☑️), wc (Restroom 🚾), mb (Meal 🍽️), f (Food Outside 🛍), l (Official Leave ❌), h (Hospital 🏥).`;
  if (await canDeleteInChat(ctx)) {
    try {
      await ctx.deleteMessage();
    } catch (err) {
      console.warn("Could not delete message", err);
    }
  }
  await ctx.reply(hint, { reply_markup: replyKeyboard });
});

// Attendance report
bot.command("report", async (ctx) => {
  const sinceWeek = startOfWeek();
  const events = await fetchEventsSince(sinceWeek);
  if (events.length === 0) {
    await ctx.reply("No attendance records yet.");
    return;
  }

  const today = summarize(events, startOfToday());
  const week = summarize(events, sinceWeek);

  const text = [
    formatSummary("Today", today),
    "",
    formatSummary("This week", week),
    "",
    formatActiveSessions(),
    "",
    `Timezone: ${TIMEZONE}`,
  ].join("\n");
  await ctx.reply(text);
});

// Start polling
(async () => {
  try {
    await ensureDb();
    await loadActiveSessions();
    bot.start();
    console.log("Bot running (polling)...");
  } catch (err) {
    console.error("Failed to start bot", err);
    process.exit(1);
  }
})();
