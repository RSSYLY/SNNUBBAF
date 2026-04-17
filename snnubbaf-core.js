// SNNUBBAF 专家系统 - 主逻辑（由后端 /script 提供）
// 在油猴薄壳中运行，上下文有 __SNNUBBAF_API__ 全局变量
//
// 流程：收集所有题目 → 一次性批量请求 → 返回第一题 → 逐题填充

(function () {
  "use strict";

  // ── GM API 桥接：通过 CustomEvent 与 TM 沙盒通信 ──

  let _menuSeq = 0;
  const _menuCallbacks = new Map();

  window.addEventListener('snnubbaf:click', (e) => {
    const cb = _menuCallbacks.get(e.detail.id);
    if (cb) cb();
  });

  const GM_REG = (name, cb) => {
    const id = ++_menuSeq;
    _menuCallbacks.set(id, cb);
    window.dispatchEvent(new CustomEvent('snnubbaf:reg', { detail: { id, name } }));
    return id;
  };

  const GM_UNREG = (id) => {
    _menuCallbacks.delete(id);
    window.dispatchEvent(new CustomEvent('snnubbaf:unreg', { detail: { id } }));
  };

  const API_URL = window.__SNNUBBAF_API__;
  if (!API_URL) { window.alert("SNNUBBAF: 未配置 API 地址"); return; }

  // ── 常量 ──────────────────────────────────────────

  const MODE_KEY     = "snnubbaf_mode";        // "pre-collecting" | "collecting" | "filling"
  const QUESTIONS_KEY = "snnubbaf_questions";   // JSON: [{question, type, typeLabel}]
  const ANSWERS_KEY  = "snnubbaf_answers";      // JSON: [answer, ...]
  const FILL_IDX_KEY = "snnubbaf_fill_idx";     // 当前填充位置
  const ERR_KEY      = "snnubbaf_err_count";    // 连续错误计数
  const START_IDX_KEY = "snnubbaf_start_idx";    // 起始题号 (1-based)
  const MAX_ERR      = 5;
  const MAX_PAGES    = 100;

  const TYPE_LABELS = {
    choice: "单选题", fill: "填空题", multi: "多选题", unknown: "未知题型",
  };

  // ── 状态管理 ──────────────────────────────────────

  function getMode()  { return sessionStorage.getItem(MODE_KEY); }
  function setMode(m) { m ? sessionStorage.setItem(MODE_KEY, m) : sessionStorage.removeItem(MODE_KEY); }
  function cleanup() {
    [MODE_KEY, QUESTIONS_KEY, ANSWERS_KEY, FILL_IDX_KEY, ERR_KEY, START_IDX_KEY]
      .forEach(k => sessionStorage.removeItem(k));
  }

  // ── 文本处理 ──────────────────────────────────────

  function normalizeText(value) {
    if (!value) return "";
    let text = String(value);
    text = text
      .replace(/\u3000/g, " ")
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    text = text
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[，]/g, ",")
      .replace(/[。]/g, ".")
      .replace(/[：]/g, ":")
      .replace(/[；]/g, ";")
      .replace(/[（]/g, "(")
      .replace(/[）]/g, ")")
      .replace(/[【]/g, "[")
      .replace(/[】]/g, "]");
    return text;
  }

  function fuzzyMatch(a, b) {
    const strip = s => normalizeText(s).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "");
    return strip(a) === strip(b);
  }

  // ── DOM 操作 ──────────────────────────────────────

  function getCurrentQuestionContainer() {
    const root = document.querySelector("#dataCollectionContainer");
    if (!root) return null;
    const candidates = Array.from(root.querySelectorAll("div.takeQuestionDiv"));
    if (!candidates.length) return null;
    const visible = candidates.find((el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    return visible || candidates[0];
  }

  function extractTitle(fieldset) {
    const titleNode = fieldset.querySelector(
      "legend.legend-visible .vtbegenerated.inlineVtbegenerated"
    );
    if (!titleNode) return "";
    return normalizeText(titleNode.textContent || "");
  }

  function extractOptions(fieldset) {
    const options = [];
    const labels = Array.from(fieldset.querySelectorAll("label"));
    for (const label of labels) {
      if (!label.getAttribute("for")) continue;
      const text = normalizeText(label.textContent || "");
      if (text) options.push(text);
    }
    if (!options.length) {
      const rows = Array.from(fieldset.querySelectorAll("tr"));
      for (const row of rows) {
        const label = row.querySelector("label");
        if (!label) continue;
        const text = normalizeText(label.textContent || "");
        if (text) options.push(text);
      }
    }
    return options;
  }

  function buildFullQuestion(title, options) {
    if (!options.length) return title;
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const optionLines = options.map(
      (opt, i) => `  ${letters[i] || i + 1}. ${opt}`
    );
    return `${title}\n${optionLines.join("\n")}`;
  }

  function detectQuestionType(fieldset) {
    if (fieldset.querySelector('input[type="checkbox"]')) return "multi";
    if (fieldset.querySelector('input[type="radio"]')) return "choice";
    if (fieldset.querySelector('input[type="text"]')) return "fill";
    return "unknown";
  }

  // ── 导航 ──────────────────────────────────────────

  /** 获取总题目数量 */
  function getTotalQuestions() {
    const span = document.querySelector("#navpaging_bottom > span");
    if (!span) return 0;
    const m = span.textContent.match(/共\s*(\d+)\s*个/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /** 获取当前题号（1-based） */
  function getCurrentQuestionIndex() {
    const strong = document.querySelector("#navpaging_bottom > span > strong:first-of-type");
    return strong ? parseInt(strong.textContent, 10) : 0;
  }

  /** 跳转到第 n 题（1-based），通过题号列表按钮 */
  function navigateToQuestion(n) {
    // 使用页面原生 navigate 函数
    if (typeof window.navigate === "function") {
      window.navigate("question_num_" + n);
      return true;
    }
    // 备选：通过顶部题号列表点击
    const topBtn = document.querySelector("#topbar > div > div.timedQuestionStatus > h3 > button");
    if (topBtn) topBtn.click();
    const xpath = `/html/body/div/div/div/div[2]/form/div[2]/div/div[3]/div/div/button[${n}]/span`;
    const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    if (result.singleNodeValue) {
      result.singleNodeValue.click();
      return true;
    }
    return false;
  }

  // ── 填 写 ─────────────────────────────────────────

  function fillTextQuestion(fieldset, answer) {
    const input = fieldset.querySelector('input[type="text"]');
    if (!input) throw new Error("未找到填空输入框");
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = answer;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }

  function clickChoices(fieldset, answer, isMulti) {
    const targets = isMulti
      ? answer.split(/[;；、]+/).map(s => s.trim()).filter(Boolean)
      : [answer.trim()];

    const inputs = Array.from(fieldset.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
    const optionMap = [];
    for (const inp of inputs) {
      const id = inp.id;
      const label = id ? fieldset.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const text = label ? (label.textContent || "").trim() : "";
      optionMap.push({ inp, text });
    }

    const matched = [];
    for (const target of targets) {
      let found = false;
      for (const { inp, text } of optionMap) {
        if (!fuzzyMatch(text, target)) continue;
        inp.checked = true;
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        inp.dispatchEvent(new Event("click", { bubbles: true }));
        matched.push(target);
        found = true;
        break;
      }
      if (!found) console.warn(`[SNNUBBAF] 未匹配选项: "${target}"`);
    }

    if (!matched.length) throw new Error(`未找到匹配选项: ${targets.join("; ")}`);
    return matched;
  }

  // ── 题目提取 ──────────────────────────────────────

  function extractCurrentQuestion() {
    const container = getCurrentQuestionContainer();
    if (!container) throw new Error("未找到当前题目容器");
    const fieldset = container.querySelector("fieldset");
    if (!fieldset) throw new Error("未找到题目 fieldset");
    const title = extractTitle(fieldset);
    if (!title) throw new Error("未提取到题目标题");
    const type = detectQuestionType(fieldset);
    const options = type !== "fill" ? extractOptions(fieldset) : [];
    const fullQuestion = buildFullQuestion(title, options);
    return { question: fullQuestion, type, typeLabel: TYPE_LABELS[type] || type };
  }

  // ── 答案填充（单题）──────────────────────────────

  function fillCurrentQuestion(answer) {
    const container = getCurrentQuestionContainer();
    if (!container) throw new Error("未找到当前题目容器");
    const fieldset = container.querySelector("fieldset");
    if (!fieldset) throw new Error("未找到题目 fieldset");
    const type = detectQuestionType(fieldset);

    if (type === "fill") {
      fillTextQuestion(fieldset, answer);
    } else if (type === "choice") {
      clickChoices(fieldset, answer, false);
    } else if (type === "multi") {
      fieldset.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      });
      clickChoices(fieldset, answer, true);
    } else {
      throw new Error("无法识别题型: " + type);
    }
  }

  // ── API ────────────────────────────────────────────

  const MAX_RETRIES = 2;
  const RETRY_DELAY = 3000;  // ms

  async function fetchBatchAnswers(questions, retries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const resp = await fetch(API_URL + "/batch-ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ questions }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          throw new Error(err.error || `API 返回 ${resp.status}`);
        }
        const data = await resp.json();
        if (!Array.isArray(data.answers)) throw new Error("API 返回格式错误");
        return data.answers;
      } catch (e) {
        if (attempt < retries) {
          console.warn(`[SNNUBBAF] API 请求失败 (${attempt + 1}/${retries + 1}): ${e.message}，${RETRY_DELAY / 1000}s 后重试...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        } else {
          throw e;  // 最后一次仍失败，向上抛出
        }
      }
    }
  }

  // ── 收集阶段 ──────────────────────────────────────

  async function handleCollecting() {
    try {
      const q = extractCurrentQuestion();
      const questions = JSON.parse(sessionStorage.getItem(QUESTIONS_KEY) || "[]");
      questions.push(q);
      sessionStorage.setItem(QUESTIONS_KEY, JSON.stringify(questions));

      const curIdx = getCurrentQuestionIndex();
      const total = getTotalQuestions();
      console.log(`[SNNUBBAF] 收集第 ${questions.length}/${total} 题 (页${curIdx}): ${q.typeLabel} | ${q.question.slice(0, 50)}...`);

      const startIdx = parseInt(sessionStorage.getItem(START_IDX_KEY) || "1", 10);
      const targetCount = total - startIdx + 1;

      if (questions.length >= targetCount || questions.length >= MAX_PAGES) {
        // 全部收集完毕，批量请求答案
        console.log(`[SNNUBBAF] 共收集 ${questions.length} 题（从第 ${startIdx} 题起），正在请求答案...`);
        const answersFromAPI = await fetchBatchAnswers(questions);

        const answerList = questions.map((_q, i) => {
          const found = answersFromAPI.find(a => a.index === i);
          return found ? found.answer : null;
        });

        sessionStorage.setItem(ANSWERS_KEY, JSON.stringify(answerList));
        sessionStorage.setItem(FILL_IDX_KEY, "0");
        setMode("filling");

        // 跳到起始题开始填充
        console.log(`[SNNUBBAF] 答案已获取，跳转第 ${startIdx} 题...`);
        navigateToQuestion(startIdx);
      } else {
        // 跳到下一题继续收集
        const nextNum = curIdx + 1;
        setTimeout(() => navigateToQuestion(nextNum), 500);
      }
    } catch (e) {
      console.error("[SNNUBBAF] 收集阶段出错:", e.message);
      cleanup();
      window.alert(`收集题目失败: ${e.message}`);
    }
  }

  // ── 填充阶段 ──────────────────────────────────────

  function handleFilling() {
    const answers = JSON.parse(sessionStorage.getItem(ANSWERS_KEY) || "[]");
    const questions = JSON.parse(sessionStorage.getItem(QUESTIONS_KEY) || "[]");
    const idx = parseInt(sessionStorage.getItem(FILL_IDX_KEY) || "0", 10);

    if (idx >= answers.length) {
      const total = answers.length;
      cleanup();
      console.log(`[SNNUBBAF] 全部 ${total} 题填充完毕`);
      window.alert(`填充完毕！共 ${total} 题。`);
      return;
    }

    // 题号校验：当前页面的题号应与 idx 对齐
    const startIdx = parseInt(sessionStorage.getItem(START_IDX_KEY) || "1", 10);
    const pageIdx = getCurrentQuestionIndex();  // 1-based
    const expectedPage = startIdx + idx;        // 1-based
    if (pageIdx && pageIdx !== expectedPage) {
      console.warn(`[SNNUBBAF] 题号不匹配！页面=${pageIdx}, 期望=${expectedPage}，跳转修正...`);
      navigateToQuestion(expectedPage);
      return;  // navigate 会重载页面，届时再次进入 handleFilling
    }

    // 题目内容校验（用标题前 20 字比对）
    try {
      const currentQ = extractCurrentQuestion();
      const expectedQ = questions[idx];
      if (expectedQ) {
        const curTitle = currentQ.question.slice(0, 20);
        const expTitle = expectedQ.question.slice(0, 20);
        if (curTitle !== expTitle) {
          console.warn(`[SNNUBBAF] 题目内容不匹配！第 ${idx + 1} 题\n  页面: ${curTitle}...\n  期望: ${expTitle}...`);
        }
      }
    } catch (_e) { /* 校验失败不阻断填充 */ }

    try {
      const answer = answers[idx];
      if (answer) {
        console.log(`[SNNUBBAF] 填充第 ${idx + 1}/${answers.length} 题: ${answer}`);
        fillCurrentQuestion(answer);
        sessionStorage.setItem(ERR_KEY, "0");
      } else {
        console.warn(`[SNNUBBAF] 第 ${idx + 1} 题无答案，跳过`);
      }
    } catch (e) {
      console.error(`[SNNUBBAF] 填充第 ${idx + 1} 题出错:`, e.message);
      const ec = parseInt(sessionStorage.getItem(ERR_KEY) || "0", 10) + 1;
      sessionStorage.setItem(ERR_KEY, String(ec));
      if (ec >= MAX_ERR) {
        cleanup();
        window.alert(`连续出错 ${MAX_ERR} 次，已停止。\n最后错误: ${e.message}`);
        return;
      }
    }

    // 前进到下一题
    sessionStorage.setItem(FILL_IDX_KEY, String(idx + 1));
    if (idx + 1 < answers.length) {
      setTimeout(() => navigateToQuestion(startIdx + idx + 1), 1000);
    } else {
      const total = answers.length;
      cleanup();
      console.log(`[SNNUBBAF] 全部 ${total} 题填充完毕`);
      window.alert(`填充完毕！共 ${total} 题。`);
    }
  }

  // ── 启动批量填充 ──────────────────────────────────

  function startBatchExecution() {
    cleanup();
    sessionStorage.setItem(QUESTIONS_KEY, "[]");
    sessionStorage.setItem(START_IDX_KEY, "1");

    // 跳到第 1 题开始收集
    const curIdx = getCurrentQuestionIndex();
    if (curIdx !== 1) {
      setMode("pre-collecting");
      console.log("[SNNUBBAF] 正在跳转到第 1 题...");
      navigateToQuestion(1);
    } else {
      setMode("collecting");
      handleCollecting();
    }
  }

  // ── 菜单 ──────────────────────────────────────────

  GM_REG("连续自动填充", () => {
    if (getMode()) {
      window.alert("正在执行中，请稍候。");
      return;
    }
    startBatchExecution();
  });

  GM_REG("从当前题开始填充", () => {
    if (getMode()) {
      window.alert("正在执行中，请稍候。");
      return;
    }
    const curIdx = getCurrentQuestionIndex();
    const total = getTotalQuestions();
    if (!curIdx || !total) {
      window.alert("无法获取当前题号信息，请确认在答题页面中。");
      return;
    }
    console.log(`[SNNUBBAF] 从第 ${curIdx}/${total} 题开始收集与填充`);
    cleanup();
    sessionStorage.setItem(QUESTIONS_KEY, "[]");
    sessionStorage.setItem(START_IDX_KEY, String(curIdx));
    setMode("collecting");
    handleCollecting();
  });

  GM_REG("停止", () => {
    cleanup();
    console.log("[SNNUBBAF] 用户手动停止");
    window.alert("已停止。");
  });

  // ── 初始化 ─────────────────────────────────────────

  console.log("[SNNUBBAF] 脚本已加载 | API: " + API_URL);

  // 页面加载后恢复执行状态（跨页保活）
  setTimeout(() => {
    const mode = getMode();
    if (mode === "pre-collecting") {
      // 已到达第一题，开始收集
      setMode("collecting");
      console.log("[SNNUBBAF] 已到达第 1 题，开始收集题目...");
      handleCollecting();
    } else if (mode === "collecting") {
      handleCollecting();
    } else if (mode === "filling") {
      handleFilling();
    }
  }, 800);
})();
