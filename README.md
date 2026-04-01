# SNNUBBAF 专家系统后端

SNNUBBAF（SNNU Blackboard Auto-Fill）是一套面向 SNNU Blackboard 平台的自动答题工具，由油猴外壳脚本 + 本地 Node.js 后端 + 向量知识库三部分组成。

## 文件说明

| 文件 | 说明 |
|------|------|
| `snnubbaf.user.js` | 油猴用户脚本（外壳），安装到浏览器 |
| `snnubbaf-core.js` | 实际执行逻辑，由后端 `/script` 接口热加载 |
| `answer-server.mjs` | 本地后端服务，提供答题 API 和向量检索 |
| `build-kb.mjs` | 知识库向量化工具，将文档写入 LanceDB |
| `source/` | 放置知识库原始文档（txt、md、docx、pdf 等） |
| `vector-db/` | LanceDB 向量数据库目录（自动生成） |

---

## 一、配置 API Key

在 `answer-server.mjs` 顶部的 `CONFIG` 对象中填写：

```js
const CONFIG = {
  llm: {
    primary: {
      baseUrl: "https://your-llm-provider/v1/chat/completions",
      apiKey: "sk-xxxxxxxx",   // 主力 LLM 的 API Key
      model: "gpt-4o",
    },
    fallback: {
      baseUrl: "https://your-llm-provider/v1/chat/completions",
      apiKey: "sk-xxxxxxxx",   // 备用 LLM 的 API Key（主力失败时自动切换）
      model: "gpt-4o-mini",
    },
  },

  embedding: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/embeddings",
    apiKey: "your-zhipu-api-key",   // 智谱 AI Embedding API Key
    model: "embedding-3",
  },
};
```

> **LLM（主力 / 备用）**：兼容 OpenAI chat/completions 接口的任意提供商均可，包括 OpenAI、DeepSeek、通义千问等中转服务。  
> **Embedding**：默认使用智谱 AI `embedding-3`，需要在 [open.bigmodel.cn](https://open.bigmodel.cn) 申请 API Key。若更换 Embedding 提供商，同步修改 `ingest.mjs` 中的 `CONFIG.embedding`，并**重新运行 ingest 建库**。

---

## 二、向量化知识库

1. 将原始文档（`.txt` `.md` `.docx` `.pdf` `.csv` `.json`）放入 `source/` 目录。

2. 安装依赖（首次）：
   ```bash
   npm install
   ```

3. 运行向量化：
   ```bash
   node build-kb.mjs
   ```
   脚本会读取 `source/` 下所有文档，分块后调用 Embedding API 写入 `vector-db/`。

4. 成功后终端会输出类似：
   ```
   ═══ SNNUBBAF 知识库向量化 ═══
   ✔ 第四章正确答案.txt → 12 块
   ✔ 共写入 12 个向量块
   ```

> 每次修改 `source/` 中的文档后，重新运行 `node ingest.mjs` 即可更新知识库。也可在后端运行时 `POST /reload` 热刷新。

---

## 三、启动后端

```bash
node answer-server.mjs
```

后端监听 `http://127.0.0.1:38765`，启动成功后输出：

```
╔══════════════════════════════════════════════════╗
║  SNNUBBAF 专家系统后端                           ║
╠══════════════════════════════════════════════════╣
║  地址: http://127.0.0.1:38765                    ║
║  主模型: gpt-4o                                  ║
║  备用: gpt-4o-mini                               ║
║  检索: 向量检索 (LanceDB)                        ║
╚══════════════════════════════════════════════════╝
```

> 若检索行显示"未加载"，说明 `vector-db/` 不存在或为空，请先执行第二步向量化。

---

## 四、安装油猴脚本

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 新建用户脚本，复制 `snnubbaf.user.js` 全部内容粘贴保存。
3. 确保本地后端已在运行（步骤三）。
4. 访问 `https://bb.snnu.edu.cn/` 任一答题页，油猴菜单中会出现"开始"和"开始自动翻页答题"选项。

---

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/ask` | 答题：`{ question, type }` |
| `GET` | `/script` | 返回 `snnubbaf-core.js`（热重载） |
| `GET` | `/health` | 健康检查 |
| `POST` | `/reload` | 热刷新知识库 + 向量库 |

