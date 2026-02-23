# Agent Investigation

**A post-mortem analysis of an AI agent pipeline that autonomously built [devrig](https://github.com/steveyackey/devrig) from a PRD to a shipping v0.6 product.**

The pipeline spent **$178.78** and **~10 hours** across 6 milestones to produce a Rust CLI with 17 commands, a SolidJS dashboard, an in-process OTLP collector, and 367 tests. This repository contains the full pipeline source code, all agent data artifacts, and a detailed analysis of cost, performance, and optimization opportunities.

## Key Findings

| Metric | Actual | Optimized Estimate |
|--------|--------|-------------------|
| Total cost | $178.78 | ~$65-85 |
| Total attempts | 14 | ~7-8 |
| Wall-clock time | ~10 hours | ~4-5 hours |
| First-pass success rate | 1/6 (17%) | 4-5/6 (67-83%) |

**The pipeline produced excellent architectural decisions but wasted ~55% of its budget on preventable retry cycles.** The primary sources of waste were mechanical failures (formatting, linting, type errors) that a pre-verification lint gate would have caught, and redundant research that re-documented known context.

## Analysis Documents

| Document | Description |
|----------|-------------|
| [Executive Summary](analysis/00-executive-summary.md) | High-level findings, scorecard, ROI analysis |
| [Cost Breakdown](analysis/01-cost-breakdown.md) | Per-milestone and per-phase cost analysis with charts |
| [Pipeline Architecture](analysis/02-pipeline-architecture.md) | How the pipeline works, phase flow, design critique |
| [Milestone Deep-Dives](analysis/03-milestone-analysis.md) | Per-milestone analysis of research, planning, execution, and failures |
| [Failure Taxonomy](analysis/04-failure-taxonomy.md) | Classification of every failure, root causes, and patterns |
| [Optimization Playbook](analysis/05-optimization-playbook.md) | Concrete changes ranked by impact-to-effort ratio |
| [Model Selection Strategy](analysis/06-model-strategy.md) | When to use Opus vs Sonnet vs Haiku for each phase |

## Raw Data

| Directory | Contents |
|-----------|----------|
| `agent-data/` | All pipeline artifacts (research, plans, execution results, verification, reports) |
| `agent-data/milestone-N/` | Per-milestone phase outputs |
| `agent-data/pipeline-state.json` | Cost tracking and attempt counts |
| `agent-data/milestones.json` | Parsed PRD milestone definitions |
| `src/` | Pipeline orchestrator source code (TypeScript) |
| `PRD.md` | The original Product Requirements Document |

## Quick Stats

```
Milestones:        6 (v0.1 through v0.6)
Total attempts:    14 (6 first-passes + 8 fix-passes)
Total cost:        $178.78
Avg cost/milestone: $29.80
Avg cost/attempt:   $12.77
Final codebase:    14,508 lines Rust + 3,056 lines TypeScript
Tests:             228 unit + 60 integration + 79 E2E = 367
CLI commands:      17
```
