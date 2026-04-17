// ==UserScript==
// @name         SNNUBBAF
// @namespace    https://bb.snnu.edu.cn/
// @version      1.0.0
// @description  给宝宝解放双手（NotebookLM 批量版）
// @match        https://bb.snnu.edu.cn/*
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// ==/UserScript==

(function () {
  "use strict";

  const API_BASE = "http://127.0.0.1:38765";
  const SCRIPT_URL = API_BASE + "/script";

  // 暴露给远端脚本
  if (typeof unsafeWindow !== "undefined") {
    unsafeWindow.__SNNUBBAF_API__ = API_BASE;
  }
  window.__SNNUBBAF_API__ = API_BASE;

  // GM API 桥接：核心脚本（页面上下文）通过 CustomEvent 调用 TM 沙盒里的 GM 函数
  // DOM 事件天然穿透 Chrome/Firefox 的隔离边界，是跨上下文通信的标准做法
  const _tmCmdIds = new Map(); // localId → TM cmdId

  window.addEventListener('snnubbaf:reg', function (e) {
    const { id, name } = e.detail;
    const cmdId = GM_registerMenuCommand(name, function () {
      window.dispatchEvent(new CustomEvent('snnubbaf:click', { detail: { id } }));
    });
    _tmCmdIds.set(id, cmdId);
  });

  window.addEventListener('snnubbaf:unreg', function (e) {
    const cmdId = _tmCmdIds.get(e.detail.id);
    if (cmdId !== undefined) {
      try { GM_unregisterMenuCommand(cmdId); } catch (_e) {}
      _tmCmdIds.delete(e.detail.id);
    }
  });

  async function loadAndRun() {
    const url = SCRIPT_URL + "?t=" + Date.now();
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`脚本加载失败: ${resp.status}`);
    const code = await resp.text();
    new Function(code)();
  }

  // 启动
  loadAndRun().catch(err => {
    console.error("[SNNUBBAF]", err);
    window.alert("SNNUBBAF 脚本加载失败: " + (err.message || err));
  });
})();
