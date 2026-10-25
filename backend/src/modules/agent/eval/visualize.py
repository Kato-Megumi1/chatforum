"""
RAG Retrieval Evaluation Visualization

Reads eval_results.json from the TypeScript evaluation module
and generates professional charts using matplotlib/seaborn.

Usage:
    pip install matplotlib seaborn pandas numpy
    python visualize.py [--input eval_results.json] [--output ./charts/]
"""

import json
import os
import argparse
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import seaborn as sns

sns.set_style("whitegrid")
plt.rcParams['font.family'] = 'sans-serif'
plt.rcParams['font.sans-serif'] = ['SimHei', 'DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False


def load_data(filepath: str) -> dict:
    with open(filepath, 'r', encoding='utf-8') as f:
        return json.load(f)


def chart_precision_recall_bars(report: dict, output_dir: str):
    """Bar chart: Precision and Recall at different K values"""
    ks = report['config']['ks']
    summary = report['summary']

    x = np.arange(len(ks))
    width = 0.35

    fig, ax = plt.subplots(figsize=(10, 6))
    precisions = [summary['avgPrecision'][str(k)] for k in ks]
    recalls = [summary['avgRecall'][str(k)] for k in ks]

    bars1 = ax.bar(x - width/2, precisions, width, label='Precision@K', color='#4A9EDC')
    bars2 = ax.bar(x + width/2, recalls, width, label='Recall@K', color='#E8A0BF')

    ax.set_xlabel('K Value', fontsize=12)
    ax.set_ylabel('Score', fontsize=12)
    ax.set_title('Precision & Recall at Different K Values', fontsize=14, fontweight='bold')
    ax.set_xticks(x)
    ax.set_xticklabels([f'K={k}' for k in ks])
    ax.legend()
    ax.set_ylim(0, 1.05)

    for bar in bars1:
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.02,
                f'{bar.get_height():.3f}', ha='center', fontsize=9)
    for bar in bars2:
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 0.02,
                f'{bar.get_height():.3f}', ha='center', fontsize=9)

    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'precision_recall_bars.png'), dpi=150)
    plt.close()
    print(f"  ✓ precision_recall_bars.png")


def chart_hit_rate_trend(report: dict, output_dir: str):
    """Line chart: Hit@K trend as K increases"""
    ks = report['config']['ks']
    summary = report['summary']
    hit_rates = [summary['avgHitRate'][str(k)] for k in ks]

    fig, ax = plt.subplots(figsize=(8, 5))
    ax.plot(ks, hit_rates, 'o-', color='#2E86AB', linewidth=2.5, markersize=8)
    ax.fill_between(ks, hit_rates, alpha=0.15, color='#2E86AB')

    for k, h in zip(ks, hit_rates):
        ax.annotate(f'{h:.1%}', (k, h), textcoords="offset points", xytext=(0, 12), ha='center', fontsize=10)

    ax.set_xlabel('K Value', fontsize=12)
    ax.set_ylabel('Hit Rate', fontsize=12)
    ax.set_title('Hit@K Trend', fontsize=14, fontweight='bold')
    ax.set_ylim(0, 1.05)
    ax.set_xticks(ks)

    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'hit_rate_trend.png'), dpi=150)
    plt.close()
    print(f"  ✓ hit_rate_trend.png")


def chart_question_type_recall(report: dict, output_dir: str):
    """Bar chart: Recall@5 by question type"""
    details = report['details']
    k = 5

    type_map = {
        'plot_detail': '情节细节',
        'character_relation': '人物关系',
        'scene_location': '场景定位',
        'text_match': '原文匹配',
        'paragraph_summary': '段落主旨',
    }

    by_type = {}
    for d in details:
        qtype = d.get('questionType', 'plot_detail')
        if qtype not in by_type:
            by_type[qtype] = []
        by_type[qtype].append(d.get('recallAtK', {}).get(str(k), 0))

    types = list(by_type.keys())
    avg_recalls = [np.mean(by_type[t]) for t in types]
    labels = [type_map.get(t, t) for t in types]

    colors = ['#4A9EDC', '#E8A0BF', '#A8C5E2', '#F2BED1', '#C9B1FF']
    fig, ax = plt.subplots(figsize=(10, 5))
    bars = ax.barh(labels, avg_recalls, color=colors[:len(labels)])

    for bar, val in zip(bars, avg_recalls):
        ax.text(bar.get_width() + 0.01, bar.get_y() + bar.get_height()/2,
                f'{val:.3f}', va='center', fontsize=10)

    ax.set_xlabel(f'Recall@{k}', fontsize=12)
    ax.set_title(f'Recall@{k} by Question Type', fontsize=14, fontweight='bold')
    ax.set_xlim(0, 1.05)

    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'recall_by_type.png'), dpi=150)
    plt.close()
    print(f"  ✓ recall_by_type.png")


def chart_pr_curve(report: dict, output_dir: str):
    """P-R Curve across K values"""
    ks = report['config']['ks']
    summary = report['summary']
    precisions = [summary['avgPrecision'][str(k)] for k in ks]
    recalls = [summary['avgRecall'][str(k)] for k in ks]

    fig, ax = plt.subplots(figsize=(8, 6))
    ax.plot(recalls, precisions, 'o-', color='#A23B72', linewidth=2.5, markersize=10,
            markerfacecolor='#F18F01', markeredgecolor='#A23B72')

    for k, p, r in zip(ks, precisions, recalls):
        ax.annotate(f'K={k}', (r, p), textcoords="offset points", xytext=(8, 8), fontsize=9)

    ax.set_xlabel('Recall', fontsize=12)
    ax.set_ylabel('Precision', fontsize=12)
    ax.set_title('Precision-Recall Curve', fontsize=14, fontweight='bold')
    ax.set_xlim(0, 1.05)
    ax.set_ylim(0, 1.05)
    ax.fill_between(recalls, precisions, alpha=0.1, color='#A23B72')

    plt.tight_layout()
    plt.savefig(os.path.join(output_dir, 'pr_curve.png'), dpi=150)
    plt.close()
    print(f"  ✓ pr_curve.png")


def main():
    parser = argparse.ArgumentParser(description='RAG Evaluation Visualization')
    parser.add_argument('--input', default='eval_results.json', help='Input JSON from retrieval-eval')
    parser.add_argument('--output', default='./charts/', help='Output directory for charts')
    args = parser.parse_args()

    os.makedirs(args.output, exist_ok=True)

    print(f"Loading {args.input}...")
    report = load_data(args.input)

    print("Generating charts...")
    chart_precision_recall_bars(report, args.output)
    chart_hit_rate_trend(report, args.output)
    chart_question_type_recall(report, args.output)
    chart_pr_curve(report, args.output)

    print(f"\nAll charts saved to {args.output}/")


if __name__ == '__main__':
    main()
