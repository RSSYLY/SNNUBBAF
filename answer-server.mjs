import { NotebookClient } from "notebooklm-client";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ============================================================
//  日 志
// ============================================================

(function setupLogger() {
  const logsDir = path.join(__dirname, "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logFile = path.join(logsDir, `${stamp}.log`);
  const stream = fs.createWriteStream(logFile, { flags: "a", encoding: "utf-8" });

  function formatArgs(args) {
    return args
      .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
      .join(" ");
  }

  function writeLog(level, args) {
    const line = `[${new Date().toISOString()}] [${level}] ${formatArgs(args)}\n`;
    stream.write(line);
  }

  for (const level of ["log", "info", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      writeLog(level.toUpperCase(), args);
    };
  }

  process.on("uncaughtException", (err) => {
    writeLog("FATAL", [`UncaughtException: ${err.stack || err.message}`]);
    stream.end(() => process.exit(1));
  });
  process.on("unhandledRejection", (reason) => {
    writeLog("FATAL", [`UnhandledRejection: ${reason instanceof Error ? reason.stack : reason}`]);
  });

  console.log(`[日志] 写入: ${logFile}`);
})();

// ============================================================
//  配 置
// ============================================================

const CONFIG = {
  port: Number(process.env.PORT ?? 38765),
  notebookId: process.env.NOTEBOOKLM_NOTEBOOK_ID,
};

if (!CONFIG.notebookId) {
  console.error("❌ 缺少环境变量 NOTEBOOKLM_NOTEBOOK_ID，请先在 .env 中配置笔记本 ID");
  console.error("   运行 npx notebooklm list --transport auto 可查看笔记本列表");
  process.exit(1);
}

// ============================================================
//  NotebookLM 客 户 端
// ============================================================

const nbClient = new NotebookClient();
let nbConnected = false;
let nbSourceIds = null;

async function ensureConnected() {
  if (nbConnected) return;
  console.log("[NotebookLM] 正在连接...");
  await nbClient.connect({ transport: "auto" });
  nbConnected = true;
  console.log("[NotebookLM] 已连接，transport:", nbClient.getTransportMode());

  // 获取笔记本来源
  const detail = await nbClient.getNotebookDetail(CONFIG.notebookId);
  nbSourceIds = detail.sources.map((s) => s.id);
  console.log(`[NotebookLM] 笔记本 "${detail.title}"，来源: ${nbSourceIds.length} 个`);
}

// ============================================================
//  批 量 答 题
// ============================================================

function buildBatchPrompt(questions) {
  const lines = questions.map((q, i) => {
    const tag = q.typeLabel || q.type || "未知题型";
    return `[${i}] [${tag}]\n${q.question}`;
  });

  return `你是一个严谨的考试答题助手。请根据笔记本中的资料回答以下全部题目。

规则：
- 单选题：返回唯一正确选项的完整原文，不带编号字母、不加引号。
- 多选题：返回所有正确选项的完整原文，用顿号"、"分隔，不带编号字母。
- 填空题：只返回空白处应填入的文字本身，不含题目中已有的前后文字。
  例如：题目"分为横向迁移与[ ]迁移"→ 正确返回"纵向"，而非"纵向迁移"。

请严格按照以下 JSON 数组格式输出，不要输出任何其他文字：
[{"index":0,"answer":"答案"},{"index":1,"answer":"答案"}]

题目列表：
===
${lines.join("\n---\n")}
===`;
}

function cleanAnswer(raw) {
  let a = (raw ?? "").trim();
  a = a.replace(/^(答案[是为：: ]*|正确答案[是为：: ]*|答[：: ]*)/i, "");
  a = a.replace(/^[A-Da-d][\.\、\)]\s*/, "");
  a = a.replace(/^[""'']|[""'']$/g, "");
  if (a.endsWith("。")) a = a.slice(0, -1);
  return a.trim();
}

function parseResponse(raw) {
  if (!raw) throw new Error("NotebookLM 返回空内容");

  // 提取 JSON（兼容 markdown 代码块）
  let jsonStr = raw;
  const m = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (m) jsonStr = m[1].trim();

  // 尝试提取 JSON 数组部分
  const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrMatch) jsonStr = arrMatch[0];

  let answers;
  try {
    answers = JSON.parse(jsonStr);
  } catch (_e) {
    console.error("[NotebookLM] JSON 解析失败:", jsonStr.slice(0, 300));
    throw new Error("NotebookLM 返回的 JSON 格式无法解析");
  }

  if (!Array.isArray(answers)) throw new Error("NotebookLM 返回格式错误：期望数组");

  return answers.map((item) => ({
    index: item.index,
    answer: cleanAnswer(item.answer),
  }));
}

async function batchAsk(questions) {
  await ensureConnected();

  const prompt = buildBatchPrompt(questions);
  console.log(`[NotebookLM] 批量请求 ${questions.length} 题, prompt_len=${prompt.length}`);

  const { text } = await nbClient.sendChat(CONFIG.notebookId, prompt, nbSourceIds);
  console.log(`[NotebookLM] 响应 len=${text?.length ?? 0}`);

  return parseResponse(text);
}

// ============================================================
//  HTTP 服 务 器
// ============================================================

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // 健康检查
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, notebookId: CONFIG.notebookId, connected: nbConnected }));
    return;
  }

  // 批量答题
  if (req.url === "/batch-ask" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { questions } = JSON.parse(body);
        if (!Array.isArray(questions) || !questions.length) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "缺少 questions 数组" }));
          return;
        }

        console.log(`[请求] 批量 ${questions.length} 题`);
        questions.forEach((q, i) => {
          const tag = q.typeLabel || q.type || "未知";
          console.log(`  [题${i}] [${tag}] ${q.question.replace(/\n/g, " | ")}`);
        });
        const answers = await batchAsk(questions);
        console.log(`[回答] 返回 ${answers.length} 个答案`);
        answers.forEach((a) => {
          console.log(`  [答${a.index}] ${a.answer}`);
        });

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answers }));
      } catch (e) {
        console.error("[错误]", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 油猴脚本（热重载）
  if (req.url.startsWith("/script") && req.method === "GET") {
    const scriptPath = path.join(__dirname, "snnubbaf-core.js");
    try {
      const code = fs.readFileSync(scriptPath, "utf-8");
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(code);
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("snnubbaf-core.js 读取失败: " + e.message);
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: "Not Found",
    endpoints: {
      "GET  /script":    "油猴脚本（热重载）",
      "GET  /health":    "健康检查",
      "POST /batch-ask": "批量答题 { questions: [{question, type, typeLabel}] }",
    },
  }));
});

// ============================================================
//  启 动
// ============================================================

server.listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  SNNUBBAF 后端 (NotebookLM)                     ║
╠══════════════════════════════════════════════════╣
║  地址: http://127.0.0.1:${String(CONFIG.port).padEnd(24)}║
║  笔记本: ${CONFIG.notebookId.padEnd(35)}║
╚══════════════════════════════════════════════════╝
  POST /batch-ask → { questions: [...] }
  GET  /script    → 油猴脚本（热重载）
  GET  /health    → 健康检查
`);
});
