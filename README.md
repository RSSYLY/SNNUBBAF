# SNNUBBAF

SNNUBBAF（SNNU Blackboard Auto-Fill）是一套面向 SNNU Blackboard 平台的自动答题工具。

工作方式：在 NotebookLM 中上传教材建立笔记本，后端通过 [notebooklm-client](https://github.com/icebear0828/notebooklm-client) 直接对接你的 NotebookLM 笔记本进行答题——脚本会自动收集所有题目、发送给 NotebookLM 回答、再逐题填入答案。**完全免费，不需要任何 API Key。**

整套工具由两部分组成：

- **油猴脚本**（浏览器端）：负责从 Blackboard 页面抓取题目、发送给后端、将答案填入页面
- **本地后端服务**（你的电脑上运行）：接收批量题目 → 发送给 NotebookLM 笔记本 → 返回答案

## 文件说明

| 文件/目录 | 说明 |
|-----------|------|
| `snnubbaf.user.js` | 油猴用户脚本，安装到浏览器中使用 |
| `snnubbaf-core.js` | 答题核心逻辑，由后端自动加载，不需要手动操作 |
| `answer-server.mjs` | 本地后端服务的主程序 |
| `.env` | 配置文件，存放笔记本 ID（需要你自己创建） |
| `example.env` | 配置文件模板，复制为 `.env` 后填入你的笔记本 ID |

---

## 第一步：安装 Node.js

1. 访问 [Node.js 官网](https://nodejs.org/)，下载 **LTS（长期支持版）**（需要 20+）
2. 安装完成后，在终端中验证：
   ```bash
   node --version
   ```

---

## 第二步：安装依赖

```bash
npm install
```

---

## 第三步：登录 NotebookLM

首次使用需要登录你的 Google 账号（之后会自动保持登录状态）：

```bash
npx notebooklm export-session
```

这会打开 Chrome 浏览器，登录你的 Google 账号即可。Session 会保存在 `~/.notebooklm` 目录中。

---

## 第四步：准备 NotebookLM 笔记本

1. 打开 [NotebookLM](https://notebooklm.google.com/)
2. 创建一个笔记本，上传你的教材/课件作为来源
3. 获取笔记本 ID（运行以下命令查看所有笔记本）：
   ```bash
   npx notebooklm list --transport auto
   ```

---

## 第五步：配置笔记本 ID

1. 复制配置模板：
   ```bash
   cp example.env .env
   ```
2. 编辑 `.env`，填入你的笔记本 ID：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `NOTEBOOKLM_NOTEBOOK_ID` | **必填**。NotebookLM 笔记本 ID | — |
| `PORT` | 后端监听端口 | `38765` |

---

## 第六步：启动后端

```bash
node answer-server.mjs
```

启动成功后终端会显示：

```
╔══════════════════════════════════════════════════╗
║  SNNUBBAF 后端 (NotebookLM)                     ║
╠══════════════════════════════════════════════════╣
║  地址: http://127.0.0.1:38765                    ║
║  笔记本: xxxxxxxx-xxxx-xxxx...                   ║
╚══════════════════════════════════════════════════╝
```

**关闭终端窗口会停止后端**，答题时需要保持终端打开。

---

## 第七步：安装油猴脚本

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 浏览器扩展
2. 点击 Tampermonkey 图标 → 「添加新脚本」
3. 粘贴 `snnubbaf.user.js` 的全部内容，保存
4. 确保后端正在运行

---

## 使用方法

1. 访问 Blackboard 答题页面
2. 点击分页栏旁的 **❤** 按钮（或从 Tampermonkey 菜单选择「连续自动填充」）
3. 脚本会自动：
   - 回到第一页
   - 逐页收集所有题目
   - 一次性发送给后端，后端通过 NotebookLM 回答
   - 回到第一页，逐题填入答案
4. 完成后弹窗提示

如需中途停止，从 Tampermonkey 菜单选择「停止」。

---

## API 接口参考

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/batch-ask` | 批量答题。请求体：`{ "questions": [{"question": "...", "type": "choice", "typeLabel": "单选题"}, ...] }` |
| `GET` | `/script` | 获取油猴核心脚本（浏览器自动调用） |
| `GET` | `/health` | 健康检查 |
