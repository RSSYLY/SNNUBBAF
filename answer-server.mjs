import { connect } from "@lancedb/lancedb";
import http from "node:http";
import https from "node:https";
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

  // 捕获进程级未处理异常，确保最后一条日志也落盘
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

  llm: {
    primary: {
      baseUrl: process.env.LLM_PRIMARY_BASE_URL ?? "https://mydamoxing.cn/v1/chat/completions",
      apiKey: process.env.LLM_PRIMARY_API_KEY,
      model: process.env.LLM_PRIMARY_MODEL ?? "MiniMax-M2.5",
    },
    fallback: {
      baseUrl: process.env.LLM_FALLBACK_BASE_URL ?? "https://mydamoxing.cn/v1/chat/completions",
      apiKey: process.env.LLM_FALLBACK_API_KEY,
      model: process.env.LLM_FALLBACK_MODEL ?? "glm-5",
    },
  },

  embedding: {
    baseUrl: process.env.EMBEDDING_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4/embeddings",
    apiKey: process.env.EMBEDDING_API_KEY,
    model: process.env.EMBEDDING_MODEL ?? "embedding-3",
  },

  dbDir: path.join(__dirname, process.env.DB_DIR ?? "vector-db"),
  topK: Number(process.env.TOP_K ?? 5),
};

// ============================================================
//  向 量 检 索（LanceDB + 智谱 Embedding）
// ============================================================

let vectorTable = null;

async function loadVectorDB() {
  try {
    const db = await connect(CONFIG.dbDir);
    const tables = await db.tableNames();
    if (!tables.includes("knowledge")) {
      console.warn("[向量] knowledge 表不存在，请先运行: node ingest.mjs");
      return;
    }
    vectorTable = await db.openTable("knowledge");
    const count = await vectorTable.countRows();
    console.log(`[向量] 已加载 ${count} 个向量块`);
  } catch (e) {
    console.error(`[向量] 加载失败: ${e.message}`);
  }
}

async function embedQuery(text) {
  const resp = await fetch(CONFIG.embedding.baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CONFIG.embedding.apiKey}`,
    },
    body: JSON.stringify({
      model: CONFIG.embedding.model,
      input: [text],
    }),
  });
  if (!resp.ok) throw new Error(`Embedding API ${resp.status}`);
  const data = await resp.json();
  return data.data[0].embedding;
}

async function vectorSearch(question, topK) {
  if (!vectorTable) return null;

  const queryVector = await embedQuery(question);
  const results = await vectorTable
    .search(queryVector)
    .limit(topK || CONFIG.topK)
    .toArray();

  return results.map((r, i) => ({
    text: r.text,
    source: r.source,
    distance: r._distance,
  }));
}

// ============================================================
//  提 示 词 模 板
// ============================================================

function buildSystemPrompt(questionType, typeLabel) {
  const base = "你是一个严谨的考试答题者，优先从知识库获取答案。如果知识库片段中确实完全不包含任何与题目相关的知识点，才返回：无法匹配答案";

  if (questionType === "choice") {
    return `${base}
【题型：${typeLabel}】
规则：
1. 逐条对比题目给出的每个选项，选出唯一正确的一项。
2. 只返回该正确选项的【完整原文】，不带编号、不带字母、不加引号。
3. 不要解释理由，不要输出多余文字。
4. 选项原文必须与题目中给出的完全一致，不得改写、缩写或补充。
5. 若知识库中找不到对应知识点，返回：无法匹配答案`;

  } else if (questionType === "multi") {
    return `${base}
【题型：${typeLabel}】
规则：
1. 逐条对比每个选项，选出所有正确的选项，尽可能列出所有正确选项，宁多勿漏。
2. 返回格式：每个正确选项的完整原文，用英文分号分隔（如：选项A原文;选项B原文）。
3. 不带编号、不带字母、不加引号。
4. 不要解释理由。
5. 确保返回的每个选项在知识库中都有依据，不要猜测。
6. 若知识库中找不到对应知识点，返回：无法匹配答案`;

  } else if (questionType === "fill") {
    return `${base}
【题型：${typeLabel}】
规则：
1. 根据上下文推断空白处应填写的内容。
2. 返回的【原文】必须与知识库中的表述【完全一致】，一字不改，不得缩写、概括或改写。
3. 不加引号，不加句号，不要解释。
4. 如果是名词填空，返回名词本身；如果是短语，返回短语。
5. 优先返回知识库中与空白上下文最匹配的原话。
6. 若知识库中找不到对应知识点，返回：无法匹配答案`;

  } else {
    return `${base}
请直接给出答案，不要解释。
若知识库中找不到对应知识点，返回：无法匹配答案`;
  }
}

// ============================================================
//  LLM 调 用
// ============================================================

async function callLLM(question, questionType, typeLabel, knowledge, provider) {
  const systemPrompt = buildSystemPrompt(questionType, typeLabel);

  let userContent = "";
  if (knowledge) {
    userContent += `【参考资料】\n${knowledge}\n\n`;
  }
  userContent += `【题型】${typeLabel}\n${question}`;

  const isResponsesAPI = provider.baseUrl.includes("/v1/responses");

  const body = isResponsesAPI
    ? JSON.stringify({
        model: provider.model,
        instructions: systemPrompt,
        input: [
          { role: "user", content: userContent },
        ],
        stream: true,
      })
    : JSON.stringify({
        model: provider.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        temperature: 0,
        max_tokens: 4096,
        stream: false,
      });

  console.log(`[LLM] model=${provider.model} | body_bytes=${Buffer.byteLength(body)} | knowledge_len=${knowledge?.length || 0} | question_len=${question.length}`);

  const url = new URL(provider.baseUrl);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${provider.apiKey}`,
        },
        timeout: 60000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            console.log(`[LLM] status=${res.statusCode} | resp_bytes=${data.length} | resp_full=${data}`);

            let json;
            const text = data.trim();
            if (text.startsWith("data:") || text.startsWith("event:")) {
              const lines = text.split("\n");
              const dataLines = lines.filter(l => l.startsWith("data:") && l.trim() !== "data: [DONE]");

              // Responses API SSE: response.output_text.done 含完整文本
              for (const line of dataLines) {
                try {
                  const chunk = JSON.parse(line.slice(5).trim());
                  if (chunk.type === "response.output_text.done" && chunk.text) {
                    const t = chunk.text.trim();
                    if (t) { console.log(`[LLM] Responses SSE done, len=${t.length}`); resolve(t); return; }
                  }
                } catch {}
              }

              // Responses API SSE: 拼接所有 delta
              const deltas = dataLines.flatMap(line => {
                try {
                  const chunk = JSON.parse(line.slice(5).trim());
                  return chunk.type === "response.output_text.delta" && chunk.delta ? [chunk.delta] : [];
                } catch { return []; }
              });
              if (deltas.length > 0) {
                const joined = deltas.join("").trim();
                if (joined) { console.log(`[LLM] Responses SSE delta, chunks=${deltas.length}, len=${joined.length}`); resolve(joined); return; }
              }

              // Chat Completions SSE: choices[].delta.content
              const content = dataLines
                .map(l => {
                  try {
                    const item = JSON.parse(l.slice(5).trim());
                    return item.choices?.[0]?.delta?.content || item.choices?.[0]?.message?.content || "";
                  } catch { return ""; }
                })
                .join("");
              if (content) { console.log(`[LLM] Chat SSE 提取成功, len=${content.length}`); resolve(content); return; }

              if (dataLines.length) {
                console.error(`[LLM] SSE 首个 data 行: ${dataLines[0]}`);
              }
              reject(new Error("LLM 返回空内容（可能上下文过长或模型无响应）"));
              return;
            }
            // 非 SSE 格式
            try {
              json = JSON.parse(text);
            } catch {
              const firstBrace = text.indexOf("{");
              const lastBrace = text.lastIndexOf("}");
              if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
                throw new Error("未找到可解析的 JSON 片段");
              }
              json = JSON.parse(text.slice(firstBrace, lastBrace + 1));
            }
            console.log(`[LLM] choices=${json.choices?.length || 0} output=${json.output?.length || 0} usage=${JSON.stringify(json.usage || {})}`);
            // Chat Completions 格式
            const answer = json.choices?.[0]?.message?.content?.trim();
            if (answer) { resolve(answer); return; }
            // Responses API 格式: output[].content[].text
            const outputMsg = json.output?.find(o => o.type === "message");
            const outputText = outputMsg?.content
              ?.filter(c => c.type === "output_text")
              .map(c => c.text)
              .join("")
              .trim();
            if (outputText) { resolve(outputText); return; }
            // 兜底: 直接取 output_text (简化代理格式)
            if (typeof json.output === "string" && json.output.trim()) { resolve(json.output.trim()); return; }
            reject(new Error(`LLM 返回格式异常: ${data}`));
          } catch (e) {
            console.error(`[LLM] 解析异常: ${e.message} | raw=${data}`);
            reject(new Error(`LLM 响应解析失败: ${e.message}`));
          }
        });
      }
    );
    req.on("error", (e) => console.error(`[LLM] 网络错误: ${e.message}`));
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("LLM 请求超时 (60s)")); });
    req.write(body);
    req.end();
  });
}

// ── 带 fallback 的调用封装 ──────────────────────────

async function callLLMWithFallback(question, questionType, typeLabel, knowledge) {
  let useFallback = false;
  try {
    const result = await callLLM(question, questionType, typeLabel, knowledge, CONFIG.llm.primary);
    const cleaned = cleanAnswer(result, questionType);
    if (cleaned === "无法匹配答案") {
      console.warn(`[LLM] 主模型 ${CONFIG.llm.primary.model} 未找到答案，切换到备用模型 ${CONFIG.llm.fallback.model}`);
      useFallback = true;
    } else {
      return result;
    }
  } catch (e) {
    console.warn(`[LLM] 主模型 ${CONFIG.llm.primary.model} 失败: ${e.message}，切换到备用模型 ${CONFIG.llm.fallback.model}`);
    useFallback = true;
  }

  if (useFallback) {
    // fallback 模型：超时时重试一次
    try {
      return await callLLM(question, questionType, typeLabel, knowledge, CONFIG.llm.fallback);
    } catch (e2) {
      if (e2.message.includes("超时") || e2.message.includes("hang up")) {
        console.warn(`[LLM] 备用模型超时，等待 2s 后重试...`);
        await new Promise((r) => setTimeout(r, 2000));
        return await callLLM(question, questionType, typeLabel, knowledge, CONFIG.llm.fallback);
      }
      throw e2;
    }
  }
}

// ============================================================
//  答 案 后 处 理
// ============================================================

function cleanAnswer(raw, questionType) {
  let answer = raw.trim();
  answer = answer.replace(/^(答案[是为：: ]*|正确答案[是为：: ]*|答[：: ]*)/i, "");
  answer = answer.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/i, "");

  if (questionType === "choice") {
    answer = answer.replace(/^[A-Da-d0-9][\.\、\)]\s*/, "");
    answer = answer.replace(/^[""'']|[""'']$/g, "");
    if (answer.endsWith("。")) answer = answer.slice(0, -1);
  }
  if (questionType === "multi") {
    answer = answer
      .split(";")
      .map(s => {
        let a = s.trim();
        a = a.replace(/^[A-Da-d0-9][\.\、\)]\s*/, "");
        a = a.replace(/^[""'']|[""'']$/g, "");
        return a;
      })
      .filter(Boolean)
      .join(";");
  }
  if (questionType === "fill") {
    answer = answer.replace(/^[""'']|[""'']$/g, "");
  }
  return answer.trim();
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
    let vectorCount = 0;
    try { if (vectorTable) vectorCount = await vectorTable.countRows(); } catch (_e) {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      model: CONFIG.llm.primary.model,
      retriever: vectorTable ? `lancedb (${vectorCount} chunks)` : "no vector DB",
    }));
    return;
  }

  // 刷新向量库
  if (req.url === "/reload" && req.method === "POST") {
    await loadVectorDB();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, message: "已刷新" }));
    return;
  }

  // 答题接口
  if (req.url === "/ask" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      try {
        const { question, type, typeLabel: labelFromClient } = JSON.parse(body);
        if (!question || typeof question !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "缺少 question 字段" }));
          return;
        }

        const questionType = type || "unknown";
        const typeLabels = { choice: "单选题", fill: "填空题", multi: "多选题", unknown: "未知题型" };
        const typeLabel = labelFromClient || typeLabels[questionType] || questionType;
        const questionOneLine = question.replace(/[\r\n]+/g, " ");
        console.log(`[请求] [${typeLabel}] ${questionOneLine}`);

        // 向量检索（按题型动态调整块数）
        const topKMap = { choice: 5, multi: 8, fill: 6, unknown: 5 };
        const topK = topKMap[questionType] || topKMap.unknown;

        let knowledge = null;
        if (vectorTable) {
          try {
            const chunks = await vectorSearch(question, topK);
            if (chunks?.length) {
              knowledge = chunks
                .map((c, i) => `【片段${i + 1}（${c.source}）】\n${c.text.slice(0, 1500)}`)
                .join("\n\n");
              console.log(`[检索] 向量命中 ${chunks.length} 块`);
            }
          } catch (e) {
            console.warn(`[检索] 向量检索失败: ${e.message}`);
          }
        }

        const rawAnswer = await callLLMWithFallback(question, questionType, typeLabel, knowledge);
        const answer = cleanAnswer(rawAnswer, questionType);
        console.log(`[回答] ${answer}`);

        if (answer === "无法匹配答案") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "知识库中未找到该题答案" }));
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ answer }));
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
      "GET /script": "油猴脚本（热重载）",
      "GET /health": "健康检查",
      "POST /reload": "刷新知识库+向量库",
      "POST /ask": "答题 { question, type? }",
    },
  }));
});

// ============================================================
//  启 动
// ============================================================

async function startup() {
  await loadVectorDB();

  const mode = vectorTable ? "向量检索 (LanceDB)" : "未加载";

  server.listen(CONFIG.port, "127.0.0.1", () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║  SNNUBBAF 专家系统后端                           ║
╠══════════════════════════════════════════════════╣
║  地址: http://127.0.0.1:${CONFIG.port}             ║
║  主模型: ${CONFIG.llm.primary.model.padEnd(35)}║
║  备用: ${CONFIG.llm.fallback.model.padEnd(37)}║
║  检索: ${mode.padEnd(37)}║
╚══════════════════════════════════════════════════╝
  POST /ask     → { question, type? }
  GET  /script  → 油猴脚本（热重载）
  GET  /health  → 健康检查
  POST /reload  → 刷新知识库+向量库
  `);
  });
}

startup();
