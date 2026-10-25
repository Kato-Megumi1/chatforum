# RAG 检索评估体系使用文档

## 一、评估脚本速查

```bash
cd backend

# 1. 全管线评估 (rewrite + RRF + 关键词 + 语义) — 最常用
node full-eval.js

# 2. 纯语义搜索评估 (只看 embedding 效果)
node compare-real.js

# 3. 生产同款关键词提取评估
node compare-prod.js
```

## 二、全管线评估 (full-eval.js)

使用与生产环境一致的完整检索管线：
rewriteQuery → extractKeywords → expandDictionary → RRF混合检索 → 指标计算

### 输出指标

| 指标 | 含义 | 当前值 (KB1) |
|------|------|------|
| **Precision@K** | Top-K 中相关段落占比 | @3=68.9% |
| **Hit@K** | Top-K 中是否找到答案 | @3=93.3% |
| **NDCG@K** | 归一化折现累计增益 | @3=0.705 |

### 当前结果

```
KB1 (RecursiveCharacterTextSplitter)
  Metric   Precision  Hit       NDCG
  @1      53.3      53.3    0.533
  @3      68.9      93.3    0.705
  @5      65.3      100.0   0.729

KB2 (EpubChunker 语义分片)
  Metric   Precision  Hit       NDCG
  @1      53.3      53.3    0.533
  @3      66.7      93.3    0.689
  @5      68.0      100.0   0.710
```

## 三、分词效果评估

### 测试关键词提取

```bash
node -e "
const { extractKeywords } = require('./测试脚本路径');
console.log(extractKeywords('惠，你和英梨梨是从什么时候开始互相直呼对方名字的？'));
"
```

### 词典覆盖率检查

```bash
# 检查词典中哪些词在 KB 中命中最少
node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('./storage/vector-stores/1.json', 'utf-8'));
const dict = require('./src/modules/agent/eval/saekano-dict');
// 遍历词典，统计每个词在 KB 中的命中数
"
```

### 对比不同分词策略

```bash
# 对比 n-gram vs 词典扩展的精确率差异
# 修改 full-eval.js 中的 extractKeywords 函数，
# 注释/取消注释词典扩展行，跑两次对比结果
```

## 四、可视化图表

### 生成图表

```bash
# 依赖安装 (仅首次)
pip install matplotlib seaborn pandas numpy

# 运行评估生成数据
node full-eval.js
# 评估结果自动保存在 eval_results.json

# 生成 4 张图表
python src/modules/agent/eval/visualize.py --input eval_results.json --output ./charts/
```

### 图表说明

| 图表 | 文件 | 说明 |
|------|------|------|
| Precision/Recall 柱状图 | `charts/precision_recall_bars.png` | 不同K值下的精确率对比 |
| Hit@K 趋势折线图 | `charts/hit_rate_trend.png` | 命中率随K增长趋势 |
| 问题类型 Recall | `charts/recall_by_type.png` | 不同问题类型的召回对比 |
| P-R 曲线 | `charts/pr_curve.png` | 精确率-召回率综合曲线 |

## 五、KB 对比评估流程

### 前提

KB1 和 KB2 已创建并完成索引：
- KB1: 加藤惠小说库 (RecursiveCharacterTextSplitter)
- KB2: 加藤惠小说库2 (EpubChunker)

### 步骤

```bash
# 1. 从 Docker 拉取最新向量数据
docker cp chatforum:/app/backend/storage/vector-stores/1.json ./storage/vector-stores/
docker cp chatforum:/app/backend/storage/vector-stores/2.json ./storage/vector-stores/

# 2. 运行全管线比较
node full-eval.js

# 3. 输出对比表 (Precision / Hit / NDCG)
# 4. 生成可视化
python src/modules/agent/eval/visualize.py
```

## 六、QA 测试集管理

测试集文件: `backend/eval-qa-set.json`

### 手动编辑

```json
{
  "id": 1,
  "question": "惠，你和英梨梨是从什么时候开始互相直呼对方名字的？",
  "answer": "原文段落...",
  "source": "manual-keyword-v2",
  "status": "confirmed"
}
```

### 自动更新答案

```bash
# 用词典增强关键词重新搜索最优答案段落
node fix-qa-v2.js
```

## 七、评估指标定义

| 指标 | 公式 | 含义 |
|------|------|------|
| Precision@K | relevant_in_topK / K | Top-K中相关段落占比 |
| Hit@K | 1 if any_relevant else 0 | 是否至少找到1个答案 |
| NDCG@K | DCG / IDCG | 考虑排序位置的综合质量 |
| (Recall已移除) | — | 分母膨胀，无实用参考意义 |
