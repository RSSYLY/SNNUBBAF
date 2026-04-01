// SNNUBBAF 专家系统 - 主逻辑（由后端 /script 提供）
// 在油猴薄壳中运行，上下文有 __SNNUBBAF_API__ 全局变量

(function () {
  "use strict";

  // GM API 桥接：通过 CustomEvent 与 TM 沙盒通信（跨隔离边界的标准方案）
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

  // ── 自动翻页常量 ──────────────────────────────────

  const SBB_KEY   = "snnubbaf";
  const TC_KEY    = "snnubbaf_turn_count";
  const EC_KEY    = "snnubbaf_err_count";
  const MAX_TURNS = 49;
  const MAX_ERR   = 3;

  // ── 题型 ──────────────────────────────────────────

  const TYPE_LABELS = {
    choice: "单选题",
    fill: "填空题",
    multi: "多选题",
    unknown: "未知题型",
  };

  const state = {
    isRunning: false,
    isProcessing: false,
    menuCommandId: null,
    apStartId: null,
    apStopId: null,
    apTimer: null,
  };

  // ── 自动翻页 sessionStorage 管理 ─────────────────

  function isAutoPage()    { return sessionStorage.getItem(SBB_KEY) === "1"; }
  function setAutoPageOn() { sessionStorage.setItem(SBB_KEY, "1"); }
  function setAutoPageOff(){ sessionStorage.removeItem(SBB_KEY); sessionStorage.removeItem(TC_KEY); sessionStorage.removeItem(EC_KEY); }

  function getTurnCount() { return parseInt(sessionStorage.getItem(TC_KEY) || "0", 10); }
  function getErrCount()  { return parseInt(sessionStorage.getItem(EC_KEY) || "0", 10); }

  function cleanAutoPage() {
    clearTimeout(state.apTimer);
    state.apTimer = null;
    setAutoPageOff();
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

  /** 模糊匹配：去标点去空格后对比 */
  function fuzzyMatch(a, b) {
    const strip = s => normalizeText(s).replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, "");
    return strip(a) === strip(b);
  }

  // ── API ────────────────────────────────────────────

  async function fetchAnswer(question, type) {
    const typeLabel = TYPE_LABELS[type] || type;
    const resp = await fetch(API_URL + "/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, type, typeLabel }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `API 返回 ${resp.status}`);
    }
    const data = await resp.json();
    if (!data.answer) throw new Error("API 返回空答案");
    return data.answer;
  }

  // ── 菜单（答题 / 自动翻页）─────────────────────

  function registerToggleMenu() {
    if (state.menuCommandId !== null) {
      try { GM_UNREG(state.menuCommandId); } catch (_e) {}
    }
    const label = state.isRunning ? "停止" : "开始";
    state.menuCommandId = GM_REG(label, () => {
      if (state.isRunning) {
        state.isRunning = false;
        state.isProcessing = false;
        registerToggleMenu();
        window.alert("已停止自动填充。");
        return;
      }
      startExecution(false);
    });
  }

  function registerAutoPageMenus() {
    // 清理旧菜单
    if (state.apStartId !== null) { try { GM_UNREG(state.apStartId); } catch (_e) {} }
    if (state.apStopId  !== null) { try { GM_UNREG(state.apStopId); }  catch (_e) {} }

    if (!isAutoPage()) {
      // 未激活 → 显示"开始"菜单
      state.apStartId = GM_REG("开始自动翻页答题", () => {
        setAutoPageOn();
        sessionStorage.setItem(TC_KEY, "0");
        sessionStorage.setItem(EC_KEY, "0");
        registerAutoPageMenus();
        window.alert("自动翻页答题已启动，将自动完成当前页后翻页。");
        startExecution(true);
      });
      state.apStopId = null;
    } else {
      // 已激活 → 显示"停止"菜单
      state.apStopId = GM_REG("停止自动翻页答题", () => {
        clearTimeout(state.apTimer);
        state.apTimer = null;
        state.isRunning = false;
        state.isProcessing = false;
        setAutoPageOff();
        registerAutoPageMenus();
        registerToggleMenu();
        window.alert("自动翻页答题已停止。");
      });
      state.apStartId = null;
    }
  }

  // ── ❤ 按 钮 ──────────────────────────────────────

  function injectButton() {
    const anchor = document.querySelector("#navpaging_bottom > span:nth-child(3)");
    if (!anchor || document.getElementById("snnubbaf-heart-btn")) return;

    const btn = document.createElement("span");
    btn.id = "snnubbaf-heart-btn";
    btn.textContent = "❤";
    btn.title = "自动答题";
    btn.style.cssText =
      "cursor:pointer;font-size:24px;vertical-align:middle;margin-left:8px;color:#e74c3c;user-select:none;";
    btn.addEventListener("click", () => {
      if (state.isProcessing) {
        window.alert("脚本正在执行，请稍候。");
        return;
      }
      startExecution(false);
    });
    anchor.after(btn);
  }

  // 轮询注入（因为页面可能动态加载分页栏）
  injectButton();
  const btnTimer = setInterval(injectButton, 1500);
  setTimeout(() => clearInterval(btnTimer), 30000);

  // ── DOM ────────────────────────────────────────────

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

  // ── 填 写 ─────────────────────────────────────────

  function fillTextQuestion(fieldset, answer) {
    const input = fieldset.querySelector('input[type="text"]');
    if (!input) throw new Error("未找到填空输入框");
    input.focus();
    // 先清空再赋值，确保 change 事件触发
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.value = answer;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  }

  function clickChoices(fieldset, answer, isMulti) {
    const targets = isMulti
      ? answer.split(";").map(s => s.trim()).filter(Boolean)
      : [answer.trim()];

    // 收集所有 checkbox/radio + 对应的 label 文本
    const inputs = Array.from(fieldset.querySelectorAll('input[type="checkbox"], input[type="radio"]'));
    const optionMap = [];
    for (const input of inputs) {
      const id = input.id;
      const label = id ? fieldset.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      const text = label ? (label.textContent || "").trim() : "";
      optionMap.push({ input, text });
    }

    const matched = [];

    for (const target of targets) {
      let found = false;
      for (const { input, text } of optionMap) {
        if (!fuzzyMatch(text, target)) continue;

        // 设置勾选状态
        input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("click", { bubbles: true }));
        matched.push(target);
        found = true;
        break;
      }
      if (!found) console.warn(`[SNNUBBAF] 未匹配选项: "${target}"`);
    }

    if (!matched.length) {
      throw new Error(`未找到匹配选项: ${targets.join("; ")}`);
    }
    return matched;
  }

  // ── 处 理 单 题 ──────────────────────────────────

  async function processQuestion() {
    const container = getCurrentQuestionContainer();
    if (!container) throw new Error("未找到当前题目容器");

    const fieldset = container.querySelector("fieldset");
    if (!fieldset) throw new Error("未找到题目 fieldset");

    const title = extractTitle(fieldset);
    if (!title) throw new Error("未提取到题目标题");

    const type = detectQuestionType(fieldset);
    console.log(`[SNNUBBAF] 题型: ${TYPE_LABELS[type] || type} | ${title.slice(0, 40)}...`);

    const options = type !== "fill" ? extractOptions(fieldset) : [];
    const fullQuestion = buildFullQuestion(title, options);
    console.log(`[SNNUBBAF] 题目: ${fullQuestion.slice(0, 80)}...`);

    const answer = await fetchAnswer(fullQuestion, type);
    if (answer === "无法匹配答案") {
      throw new Error("知识库中未找到该题答案");
    }
    console.log(`[SNNUBBAF] 答案: ${answer}`);

    if (type === "fill") {
      fillTextQuestion(fieldset, answer);
    } else if (type === "choice") {
      clickChoices(fieldset, answer, false);
    } else if (type === "multi") {
      // 先清空所有勾选
      fieldset.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
      });
      const matched = clickChoices(fieldset, answer, true);
      console.log(`[SNNUBBAF] 多选已勾选: ${matched.join("; ")}`);
    } else {
      throw new Error("无法识别题型");
    }

    return answer;
  }

  // ── 自动翻页：翻页 + 等待 ────────────────────────

  function getNextPageButton() {
    return document.querySelector("#navpaging_bottom > button:nth-child(5)");
  }

  async function autoPageTurn() {
    if (!isAutoPage()) return;

    // 错误次数上限
    if (getErrCount() >= MAX_ERR) {
      console.warn("[SNNUBBAF] 连续错误次数超限，停止自动翻页");
      cleanAutoPage();
      registerAutoPageMenus();
      window.alert("连续出错已达上限，自动翻页已停止。");
      return;
    }

    // 查找下一页按钮
    const nextBtn = getNextPageButton();
    if (!nextBtn) {
      // 没有下一页 → 答题结束
      const totalTurns = getTurnCount();
      cleanAutoPage();
      registerAutoPageMenus();
      registerToggleMenu();
      state.isRunning = false;
      state.isProcessing = false;
      console.log(`[SNNUBBAF] 自动翻页完成，共处理 ${totalTurns} 页`);
      window.alert(`答题完毕！共处理 ${totalTurns} 页。`);
      return;
    }

    // 激活次数上限
    const tc = getTurnCount();
    if (tc >= MAX_TURNS) {
      cleanAutoPage();
      registerAutoPageMenus();
      registerToggleMenu();
      state.isRunning = false;
      state.isProcessing = false;
      console.log(`[SNNUBBAF] 已达 ${MAX_TURNS} 页上限`);
      window.alert(`已处理 ${MAX_TURNS} 页，达到自动翻页上限，已停止。`);
      return;
    }

    // 等待 2 秒后点击下一页
    console.log("[SNNUBBAF] 等待 2 秒后翻页...");
    state.apTimer = setTimeout(() => {
      if (!isAutoPage()) return; // 用户可能在此期间停止了
      sessionStorage.setItem(TC_KEY, String(tc + 1));
      console.log("[SNNUBBAF] 点击下一页...");
      nextBtn.click();
    }, 2000);
  }

  // ── 主 流 程 ──────────────────────────────────────

  async function startExecution(fromAutoPage) {
    if (state.isProcessing) {
      window.alert("脚本正在执行，请稍候。");
      return;
    }
    state.isRunning = true;
    state.isProcessing = true;
    if (!fromAutoPage) registerToggleMenu();

    try {
      await processQuestion();
      state.isRunning = false;
      state.isProcessing = false;
      if (!fromAutoPage) registerToggleMenu();

      // 自动翻页逻辑
      if (fromAutoPage || isAutoPage()) {
        await autoPageTurn();
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[SNNUBBAF] 错误:", msg);
      state.isRunning = false;
      state.isProcessing = false;

      if (fromAutoPage || isAutoPage()) {
        // 自动翻页模式 → 记录错误但不弹窗，直接翻页
        const ec = getErrCount() + 1;
        sessionStorage.setItem(EC_KEY, String(ec));
        console.warn(`[SNNUBBAF] 自动翻页模式出错 (${ec}/${MAX_ERR})`);
        await autoPageTurn();
      } else {
        registerToggleMenu();
        window.alert(`执行失败，已停止。\n原因: ${msg}`);
      }
    }
  }

  // ── 启 动 ─────────────────────────────────────────

  registerToggleMenu();
  registerAutoPageMenus();
  console.log("[SNNUBBAF] 脚本已加载 | API: " + API_URL);

  // 页面加载时，如果 snnubbaf=1 则自动开始
  if (isAutoPage()) {
    const tc = getTurnCount();
    console.log(`[SNNUBBAF] 检测到自动翻页模式（第 ${tc + 1} 页），自动开始`);
    startExecution(true);
  }
})();
