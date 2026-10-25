# RAG 检索效果评估体系

完整的 EPUB 小说知识库检索评估工具链，包含结构化分片、自动生成测试集、多维度指标计算、可视化图表。

## 快速开始

```bash
# 1. 分片 + 评估
npx ts-node src/modules/agent/eval/eval-runner.ts --epub novel.epub --qaCount 60

# 2. 可视化
python src/modules/agent/eval/visualize.py --input eval_results.json --output ./charts/

# 3. 快速对比两个 KB
node compare-prod.js    # 全管线（rewrite + RRF + 关键词 + 语义）
node compare-real.js    # 纯语义搜索
node full-eval.js       # 模拟生产管线完整评估
```

## 测试集

15 题 QA 测试集位于 `backend/eval-qa-set.json`，覆盖情节细节、人物关系、场景定位等类型。

## 评估指标

| 指标 | 当前值 (RRF全管线) |
|------|------|
| Hit@1 | 53.3% |
| Hit@3 | 93.3% |
| Hit@5 | 100% |
| Hit@10 | 100% |

## 模块

| 文件 | 功能 |
|------|------|
| `epub-chunker.ts` | EPUB 章节级语义分片（不跨章+对话完整+metadata） |
| `qa-generator.ts` | LLM 自动生成 QA 测试集 |
| `retrieval-eval.ts` | P@K / R@K / Hit@K / NDCG@K |
| `visualize.py` | matplotlib 4 张评估图表 |
| `eval-runner.ts` | 一键运行全流程 |
