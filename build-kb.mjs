/**
 * SNNUBBAF 知识库构建一体化脚本
 *
 * 用法:
 *   node build-kb.mjs                    # 全流程：预处理 → [概念提取] → 向量入库
 *   node build-kb.mjs --with-concepts    # 强制开启概念提取（覆盖 .env 默认 false）
 *   node build-kb.mjs --skip-concepts    # 强制跳过概念提取（覆盖 .env 默认 true）
 *   node build-kb.mjs --only preprocess  # 只跑预处理
 *   node build-kb.mjs --only concepts    # 只跑概念提取
 *   node build-kb.mjs --only ingest      # 只跑向量入库
 *
 * source/ 目录下所有 .txt 文件均会被处理：
 *   - 有章节结构（第X章/第X节）的 → 按章节拆分
 *   - 无章节结构的 → 按源文件名整体输出
 */
import { connect } from "@lancedb/lancedb";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ════════════════════════════════════════════════════════
//  配 置
// ════════════════════════════════════════════════════════

const CONFIG = {
  sourceDir: path.join(__dirname, process.env.SOURCE_DIR ?? "source"),
  processedDir: path.join(__dirname, process.env.PROCESSED_DIR ?? "source-processed"),
  dbDir: path.join(__dirname, process.env.DB_DIR ?? "vector-db"),

  embedding: {
    baseUrl: process.env.EMBEDDING_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4/embeddings",
    apiKey: process.env.EMBEDDING_API_KEY,
    model: process.env.EMBEDDING_MODEL ?? "embedding-3",
  },

  llm: {
    baseUrl: process.env.BUILD_LLM_BASE_URL ?? "https://mydamoxing.cn/v1/chat/completions",
    apiKey: process.env.BUILD_LLM_API_KEY,
    model: process.env.BUILD_LLM_MODEL ?? "glm-5",
  },

  chunkSize: Number(process.env.CHUNK_SIZE ?? 1200),
  chunkOverlap: Number(process.env.CHUNK_OVERLAP ?? 300),
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ════════════════════════════════════════════════════════
//  Step 1 — 预 处 理
// ════════════════════════════════════════════════════════

const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnNum(s) {
  if (!s) return 0;
  if (s.length === 1) return CN[s] || 0;
  if (s === "十") return 10;
  if (s.startsWith("十")) return 10 + (CN[s[1]] || 0);
  if (s.endsWith("十")) return (CN[s[0]] || 0) * 10;
  return 0;
}

const CHAPTER_RE = /^第([一二三四五六七八九十]+)章\s*(.*)/;
const SECTION_RE = /^第([一二三四五六七八九十]+)节\s*(.*)/;

function cleanLine(line) {
  return line
    .replace(/中学生认知与学习<<</, "")
    .replace(/>>>第.{1,5}章.{0,30}/, "")
    .replace(/^\d{1,3}$/, "")
    .trim();
}

function cleanTitle(t) {
  return t.replace(/[…·.\s]+$/, "").replace(/\s+/g, "").trim();
}

/** 从源文件名派生安全前缀（去括号注释、截断、替换非法字符） */
function getSourcePrefix(filename) {
  return filename
    .replace(/\.txt$/i, "")
    .replace(/[（(【\[].*/g, "")
    .trim()
    .slice(0, 20)
    .replace(/[/\\:*?"<>| ]+/g, "_")
    .replace(/_+$/g, "");
}

/** 判断一个 txt 文件是否有章节结构 */
function hasChapterStructure(text) {
  const lines = text.split("\n").slice(0, 300); // 只看前 300 行
  let chapterCount = 0;
  for (const line of lines) {
    if (CHAPTER_RE.test(line.trim())) chapterCount++;
    if (chapterCount >= 2) return true;
  }
  return false;
}

/** 对有章节结构的教材文本按章节拆分 */
function splitByChapters(text, filePrefix) {
  const lines = text.split("\n");

  // 定位正文范围
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (CHAPTER_RE.test(lines[i].trim())) { start = i; break; }
  }
  let end = lines.length;
  for (let i = lines.length - 1; i > start; i--) {
    if (/^参考文献/.test(lines[i].trim())) { end = i; break; }
  }

  const body = lines.slice(start, end);
  const segments = [];
  let curChapter = "", curChapterNum = 0, curSection = "", curSectionNum = 0;
  let buf = [];

  function flush() {
    const t = buf.map(cleanLine).filter(Boolean).join("\n").trim();
    if (t.length < 30) { buf = []; return; }
    segments.push({
      chapter: curChapter, chapterNum: curChapterNum,
      section: curSection, sectionNum: curSectionNum,
      text: t,
    });
    buf = [];
  }

  for (const line of body) {
    const t = line.trim();
    const chM = t.match(CHAPTER_RE);
    if (chM) {
      const newNum = cnNum(chM[1]);
      if (newNum === curChapterNum) continue; // 页眉重复
      flush();
      curChapterNum = newNum;
      curChapter = `第${chM[1]}章 ${cleanTitle(chM[2])}`;
      curSection = ""; curSectionNum = 0;
      continue;
    }
    const secM = t.match(SECTION_RE);
    if (secM) {
      flush();
      curSectionNum = cnNum(secM[1]);
      curSection = `第${secM[1]}节 ${cleanTitle(secM[2])}`;
      continue;
    }
    buf.push(line);
  }
  flush();

  // 生成输出文件
  const result = [];
  for (const seg of segments) {
    const chNum = String(seg.chapterNum).padStart(2, "0");
    const secNum = String(seg.sectionNum).padStart(2, "0");
    const label = seg.section ? `${seg.chapter} > ${seg.section}` : seg.chapter;
    const secTitle = seg.section ? seg.section.replace(/^第.节\s*/, "") : "概述";
    const safeName = secTitle.slice(0, 20).replace(/[/\\:*?"<>|]/g, "_");
    const filename = `${filePrefix}-ch${chNum}-s${secNum}-${safeName}.txt`;
    const content = `[章节: ${label}]\n${seg.text}\n`;
    result.push({ filename, content, chapter: seg.chapter });
  }
  return result;
}

/** 对无章节结构的文本，整体输出为一个文件（使用源文件名前缀） */
function processPlainFile(text, originalName, prefix) {
  const filename = `${prefix}.txt`;
  const content = `[来源: ${originalName}]\n${text}\n`;
  return [{ filename, content, chapter: originalName }];
}

function preprocess() {
  console.log("═══ Step 1: 预处理 ═══\n");

  if (!fs.existsSync(CONFIG.sourceDir)) {
    console.error(`source 目录不存在: ${CONFIG.sourceDir}`);
    process.exit(1);
  }

  // 收集 source/ 下所有 .txt
  const txtFiles = fs
    .readdirSync(CONFIG.sourceDir)
    .filter((f) => f.toLowerCase().endsWith(".txt"))
    .sort();

  if (!txtFiles.length) {
    console.error("source/ 目录下没有 .txt 文件");
    process.exit(1);
  }

  console.log(`找到 ${txtFiles.length} 个 txt 文件:\n`);

  // 清空 processed 目录（完全重建）
  if (fs.existsSync(CONFIG.processedDir)) {
    fs.rmSync(CONFIG.processedDir, { recursive: true, force: true });
  }
  fs.mkdirSync(CONFIG.processedDir, { recursive: true });

  let totalFiles = 0;
  for (const txtFile of txtFiles) {
    const fullPath = path.join(CONFIG.sourceDir, txtFile);
    const raw = fs.readFileSync(fullPath, "utf-8");

    // 文件名前缀：使用源文件名派生，便于溯源
    const prefix = getSourcePrefix(txtFile);

    let outputs;
    if (hasChapterStructure(raw)) {
      outputs = splitByChapters(raw, prefix);
      const chapters = [...new Set(outputs.map((o) => o.chapter))];
      console.log(`  📖 ${txtFile} → 教材模式, ${outputs.length} 个段落, ${chapters.length} 章`);
      for (const ch of chapters) {
        const segs = outputs.filter((o) => o.chapter === ch);
        const chars = segs.reduce((a, o) => a + o.content.length, 0);
        console.log(`      ${ch}: ${segs.length} 节, ${chars} 字`);
      }
    } else {
      outputs = processPlainFile(raw, txtFile, prefix);
      console.log(`  📄 ${txtFile} → 纯文本模式, ${raw.length} 字`);
    }

    for (const o of outputs) {
      fs.writeFileSync(path.join(CONFIG.processedDir, o.filename), o.content, "utf-8");
    }
    totalFiles += outputs.length;
  }

  console.log(`\n✅ 预处理完成: ${totalFiles} 个文件 → ${CONFIG.processedDir}\n`);
  return totalFiles;
}

// ════════════════════════════════════════════════════════
//  Step 2 — 概 念 提 取
// ════════════════════════════════════════════════════════

const CONCEPT_SYSTEM_PROMPT = `你是一个教育心理学教材分析专家。请从给定的教材内容中提取所有关键的学术术语、概念和重要知识点，给出准确定义。

要求：
1. 每个概念/知识点独占一段，段之间用空行分隔
2. 格式：术语名称(英文名，如有): 定义或解释（忠实于原文表述）
3. 包含提出者、实验名称、理论名称
4. 分类、特征、规律也要提取，如"强化的类型包括正强化和负强化"
5. 不要遗漏任何可能出现在考试中的知识点
6. 不要添加原文中没有的内容`;

async function callLLM(system, user, retries = 20) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(CONFIG.llm.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CONFIG.llm.apiKey}`,
        },
        body: JSON.stringify({
          model: CONFIG.llm.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0,
          max_tokens: 4096,
        }),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`LLM ${resp.status}: ${err.slice(0, 200)}`);
      }

      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text) return text;

      const raw = JSON.stringify(data);
      if (raw.includes("delta")) {
        const content = (data.choices || [])
          .map((c) => c.delta?.content || c.message?.content || "")
          .join("");
        if (content) return content;
      }

      throw new Error("Empty LLM response");
    } catch (e) {
      if (attempt < retries) {
        const backoff = attempt * 5000;
        console.warn(`  ⚠ 第 ${attempt} 次失败: ${e.message}, ${backoff / 1000}s 后重试...`);
        await sleep(backoff);
      } else {
        throw e;
      }
    }
  }
}

async function extractConcepts() {
  console.log("═══ Step 2: 概念提取 ═══\n");

  const files = fs
    .readdirSync(CONFIG.processedDir)
    .filter((f) => f.endsWith(".txt") && f !== "00-概念索引.txt")
    .sort();

  if (!files.length) {
    console.error("source-processed/ 为空，请先运行预处理");
    process.exit(1);
  }

  console.log(`共 ${files.length} 个段落文件\n`);

  const conceptsByGroup = {};

  for (const file of files) {
    const content = fs.readFileSync(path.join(CONFIG.processedDir, file), "utf-8");

    // 提取分组信息
    const headerMatch = content.match(/\[(章节|来源): ([^\]]+)\]/);
    const fullLabel = headerMatch ? headerMatch[2] : file;
    const groupName = fullLabel.split(">")[0].trim();

    const bodyText = headerMatch
      ? content.slice(content.indexOf("\n") + 1)
      : content;

    if (bodyText.length < 200) {
      console.log(`  跳过 ${file} (太短: ${bodyText.length} 字)`);
      continue;
    }

    console.log(`  提取: ${file} (${bodyText.length} 字)`);

    const maxChunk = 6000;
    const parts = [];
    for (let i = 0; i < bodyText.length; i += maxChunk) {
      parts.push(bodyText.slice(i, Math.min(i + maxChunk, bodyText.length)));
    }

    for (let i = 0; i < parts.length; i++) {
      if (parts.length > 1) console.log(`    [${i + 1}/${parts.length}]`);

      const prompt = `以下是「${fullLabel}」的内容。请提取关键概念和知识点：\n\n${parts[i]}`;

      try {
        const result = await callLLM(CONCEPT_SYSTEM_PROMPT, prompt);
        const concepts = result
          .split(/\n\n+/)
          .map((p) => p.trim())
          .filter((p) => p.length > 10);

        if (!conceptsByGroup[groupName]) conceptsByGroup[groupName] = [];
        conceptsByGroup[groupName].push(...concepts);
        console.log(`    → ${concepts.length} 个概念`);
      } catch (e) {
        console.error(`    ✗ ${e.message}`);
      }

      await sleep(5000);
    }
  }

  // 输出
  const outputPath = path.join(CONFIG.processedDir, "00-概念索引.txt");
  const outputParts = [];
  let total = 0;

  for (const [group, concepts] of Object.entries(conceptsByGroup)) {
    if (!concepts.length) continue;
    outputParts.push(`[概念索引: ${group}]\n${concepts.join("\n\n")}`);
    total += concepts.length;
  }

  fs.writeFileSync(outputPath, outputParts.join("\n\n"), "utf-8");
  console.log(`\n✅ 概念提取完成: ${total} 个概念 → ${outputPath}\n`);
}

// ════════════════════════════════════════════════════════
//  Step 3 — 向 量 入 库
// ════════════════════════════════════════════════════════

function chunkText(text, source) {
  let metaPrefix = "";
  let chapter = "";
  let section = "";
  const metaMatch = text.match(/^\[(章节|概念索引|来源): ([^\]]+)\]\n/);
  if (metaMatch) {
    metaPrefix = metaMatch[0].trimEnd() + "\n";
    const parts = metaMatch[2].split(">").map((s) => s.trim());
    chapter = parts[0] || "";
    section = parts[1] || "";
  }

  const bodyText = metaMatch ? text.slice(metaMatch[0].length) : text;
  const paragraphs = bodyText
    .split(/\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 10);

  const chunks = [];
  let buffer = "";

  for (const para of paragraphs) {
    if (buffer.length + para.length + 1 > CONFIG.chunkSize && buffer.length > 0) {
      chunks.push({ text: (metaPrefix + buffer).trim(), source, chapter, section });
      const overlap = buffer.slice(-CONFIG.chunkOverlap);
      buffer = overlap + " " + para;
    } else {
      buffer += (buffer ? "\n" : "") + para;
    }
  }
  if (buffer.trim().length > 10) {
    chunks.push({ text: (metaPrefix + buffer).trim(), source, chapter, section });
  }
  return chunks;
}

async function embedOne(input, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const resp = await fetch(CONFIG.embedding.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CONFIG.embedding.apiKey}`,
      },
      body: JSON.stringify({ model: CONFIG.embedding.model, input }),
    });

    if (resp.ok) {
      const data = await resp.json();
      return data.data[0].embedding;
    }

    const err = await resp.text();
    if (attempt < retries) {
      console.warn(`  ⚠ embedding 第 ${attempt} 次失败 (${resp.status}), ${attempt * 1000}ms 后重试...`);
      await sleep(attempt * 1000);
    } else {
      throw new Error(`Embedding API 错误 ${resp.status}: ${err}`);
    }
  }
}

async function getEmbeddings(texts) {
  const allVectors = [];
  for (let i = 0; i < texts.length; i++) {
    if (!texts[i] || texts[i].trim().length === 0) {
      allVectors.push(null);
      continue;
    }
    const input = texts[i]
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFEFF\u200B-\u200F\u2028\u2029]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 4000);

    if (!input) { allVectors.push(null); continue; }

    try {
      allVectors.push(await embedOne(input));
    } catch (e) {
      console.error(`  块 [${i}] 预览: ${texts[i].slice(0, 120)}`);
      throw e;
    }

    if ((i + 1) % 10 === 0 || i + 1 === texts.length) {
      console.log(`  [embedding] ${i + 1}/${texts.length}`);
    }
    await sleep(110);
  }
  return allVectors;
}

async function ingest() {
  console.log("═══ Step 3: 向量入库 ═══\n");

  if (!fs.existsSync(CONFIG.processedDir)) {
    console.error(`source-processed/ 不存在，请先运行预处理`);
    process.exit(1);
  }

  const files = [];
  for (const f of fs.readdirSync(CONFIG.processedDir)) {
    if (f.endsWith(".txt")) files.push(path.join(CONFIG.processedDir, f));
  }
  files.sort();

  if (!files.length) {
    console.error("source-processed/ 目录为空");
    process.exit(1);
  }

  console.log(`[1/4] 找到 ${files.length} 个文件`);

  // 分块
  const allChunks = [];
  for (const f of files) {
    const rel = path.basename(f);
    const content = fs.readFileSync(f, "utf-8");
    const chunks = chunkText(content, rel);
    console.log(`  ${rel}: ${content.length} 字 → ${chunks.length} 块`);
    allChunks.push(...chunks);
  }

  if (!allChunks.length) {
    console.error("没有任何文本块");
    process.exit(1);
  }
  console.log(`\n[2/4] 共 ${allChunks.length} 个文本块`);

  // 向量化
  console.log(`\n[3/4] 调用智谱 embedding-3...`);
  const vectors = await getEmbeddings(allChunks.map((c) => c.text));
  const validPairs = allChunks
    .map((chunk, i) => ({ chunk, vector: vectors[i] }))
    .filter((p) => p.vector !== null);
  const dim = validPairs[0].vector.length;
  console.log(`  维度: ${dim}，有效块: ${validPairs.length}/${allChunks.length}`);

  // 写入 LanceDB（清除旧目录完整重建）
  console.log(`\n[4/4] 写入 LanceDB...`);
  if (fs.existsSync(CONFIG.dbDir)) {
    fs.rmSync(CONFIG.dbDir, { recursive: true, force: true });
    console.log(`  已清除旧知识库目录`);
  }
  const db = await connect(CONFIG.dbDir);

  const records = validPairs.map(({ chunk, vector }) => ({
    vector,
    text: chunk.text,
    source: chunk.source,
    chapter: chunk.chapter || "",
    section: chunk.section || "",
  }));

  const table = await db.createTable("knowledge", records);
  const count = await table.countRows();

  console.log(`\n✅ 入库完成: ${count} 个向量块 → ${CONFIG.dbDir}\n`);
}

// ════════════════════════════════════════════════════════
//  CLI
// ════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;

  // 概念提取开关：--with-concepts > --skip-concepts > EXTRACT_CONCEPTS 环境变量（默认 false）
  const extractConceptsEnabled =
    args.includes("--with-concepts") ? true
    : args.includes("--skip-concepts") ? false
    : (process.env.EXTRACT_CONCEPTS ?? "false").toLowerCase() === "true";

  const t0 = Date.now();

  if (only === "preprocess") {
    preprocess();
  } else if (only === "concepts") {
    await extractConcepts();
  } else if (only === "ingest") {
    await ingest();
  } else {
    // 全流程
    preprocess();
    if (extractConceptsEnabled) {
      await extractConcepts();
    } else {
      console.log("═══ Step 2: 概念提取（已跳过，可设 EXTRACT_CONCEPTS=true 或加 --with-concepts 开启）═══\n");
    }
    await ingest();
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`总耗时: ${elapsed}s`);
}

main().catch((e) => {
  console.error("❌ 失败:", e.message);
  process.exit(1);
});
