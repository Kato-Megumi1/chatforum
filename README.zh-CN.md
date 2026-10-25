# ChatForum

普通 AI 助手、可追溯的小说角色对话与社区论坛。采用 Vue 3 / TypeScript / Vite、NestJS / Prisma、MySQL 8、Redis 7、Qdrant，论坛搜索可选 OpenSearch。

[在线体验](https://kato-megumi1.github.io/chatforum-web/) · [33 秒演示视频](https://kato-megumi1.github.io/#work) · [作者主页](https://kato-megumi1.github.io/) · [English](README.md)

[![项目演示](https://kato-megumi1.github.io/assets/demo-poster.jpg)](https://kato-megumi1.github.io/#work)

## 已实现的内容

- 普通 AI 与角色对话采用独立身份和记忆。普通 AI 支持附件、Agent 工具与可下载文件提案，修改会话副本需要用户确认。
- 小说问答组合向量和中文 n-gram 检索、重排、场景证据、角色表达及独立核验。引用可以打开对应文档版本，人物指南不作为正史证据。
- 普通用户可以管理自己的私有知识库。索引先构建、校验，再显式发布；检索、生成交付及引用读取重新检查权限。
- 持久化聊天任务通过 SSE 增量交付并按偏移续传。跨会话记忆默认关闭，按用户、模式与角色隔离。
- 社区提供帖子、评论、搜索、关注、收藏、私信、通知与需要用户独立确认的 Agent 追踪操作。

角色检索当前面向《不起眼女主角培育法》。仓库不附带小说、向量库、用户内容及私有评测数据；请使用你有权处理的材料。在线网页依赖独立部署的后端保持运行。

## 启动

准备 Node.js 22.13+ 和 Docker Compose，克隆后执行：

```sh
node scripts/setup-local.cjs
```

在本机 `backend/.env` 填写所需模型密钥；默认 Qwen 使用 `DASHSCOPE_API_KEY`，构建文档索引还需要 `EMBEDDING_API_KEY`。不要把服务端密钥放进 `VITE_*` 配置。

```sh
node scripts/chatforum-compose.cjs production plan
node scripts/chatforum-compose.cjs production up
node scripts/bootstrap-local.cjs
```

网页为 http://localhost:8080。初始化信息保存在忽略目录 `.local/admin-bootstrap.env`；不会重置已有账号。独立管理台只映射到 127.0.0.1:8091，不应进入公网反向代理。程序使用版本迁移创建结构，不导入演示账号和帖子。

详细步骤见 [部署指南](docs/DEPLOYMENT.md)，源码分层见 [架构说明](docs/ARCHITECTURE.md)，开发检查见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 开源范围

公开仓库使用独立源码快照，不携带私有仓库旧历史。提供前后端、24 条 Prisma 迁移、依赖锁文件和必要脚本，不提供真实 `.env`、API key、数据库、备份、小说、上传附件、预建索引及运行导出。

`grounded` 是当轮自动核验状态，不是人工准确率；开发诊断不等于盲测结果，也没有百万级容量实测承诺。

原始源码采用 [MIT](LICENSE)；第三方依赖、美术素材与标识的权利见 [NOTICE.md](NOTICE.md)。

作者：[PengYao](https://kato-megumi1.github.io/)，天津大学研零，关注具身智能与强化学习。
