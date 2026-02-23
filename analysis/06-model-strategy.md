# Model Selection Strategy

The pipeline currently uses `claude-sonnet-4-6` uniformly for all phases. Each phase has different cognitive demands, and matching the model to the task can significantly reduce costs.

## Current State

```
  All phases:  Sonnet 4.6
  Input:  $3 / M tokens
  Output: $15 / M tokens
```

## Proposed Model Routing

| Phase | Current Model | Recommended Model | Reasoning |
|-------|--------------|-------------------|-----------|
| **Parse** | Sonnet | **Haiku** | Structured extraction from text. No creativity needed. |
| **Research** | Sonnet | **Sonnet** | Needs synthesis, judgment, web search interpretation |
| **Architect** | Sonnet | **Sonnet** or **Opus** for M0 | Design decisions require intelligence. M0 is foundational. |
| **Execute** | Sonnet | **Sonnet** | Code generation needs strong coding ability |
| **Verify** | Sonnet | **Haiku** | Runs commands and checks output. Minimal reasoning. |
| **Fix** | Sonnet | **Sonnet** | Targeted debugging needs intelligence |
| **Report** | Sonnet | **Haiku** | Text synthesis from existing artifacts |
| **Final Report** | Sonnet | **Haiku** | Same — aggregation, not analysis |

## Cost Comparison

### Haiku vs Sonnet Pricing

```
  Haiku:   Input $0.80/M  Output $4/M    (~3.5x cheaper)
  Sonnet:  Input $3/M     Output $15/M
  Opus:    Input $15/M    Output $75/M   (~5x more expensive)
```

### Estimated Savings with Model Routing

Based on estimated phase cost distribution:

| Phase | Current Cost | With Routing | Savings |
|-------|-------------|-------------|---------|
| Parse (~2%) | ~$3.50 | ~$1.00 (Haiku) | $2.50 |
| Research (~15%) | ~$27 | ~$27 (Sonnet) | $0 |
| Architect (~10%) | ~$18 | ~$18 (Sonnet) | $0 |
| Execute (~35%) | ~$63 | ~$63 (Sonnet) | $0 |
| Verify (~10%) | ~$18 | ~$5 (Haiku) | $13 |
| Fix (~20%) | ~$36 | ~$36 (Sonnet) | $0 |
| Report (~8%) | ~$14 | ~$4 (Haiku) | $10 |
| **Total** | **$178.78** | **~$154** | **~$25** |

### With Combined Optimizations

If we also eliminate most fix cycles (via lint gate), the fix phase shrinks dramatically:

| Phase | Optimized Cost | With Model Routing | Total Savings |
|-------|---------------|-------------------|---------------|
| Parse | ~$3.50 | ~$1.00 | $2.50 |
| Research | ~$18 (adaptive) | ~$18 | $9 |
| Architect | ~$18 | ~$18 | $0 |
| Execute | ~$55 (with self-lint) | ~$55 | $8 |
| Verify | ~$12 | ~$3.50 | $14.50 |
| Fix | ~$10 (fewer retries) | ~$10 | $26 |
| Report | ~$14 | ~$4 | $10 |
| **Total** | **~$130** | **~$110** | **~$70** |

## Implementation

In `pipeline.ts`, add model routing:

```typescript
const PHASE_MODELS: Record<string, string> = {
  parse: "claude-haiku-4-5-20251001",
  research: config.model,        // Use configured model (default: Sonnet)
  architect: config.model,
  execute: config.model,
  verify: "claude-haiku-4-5-20251001",
  fix: config.model,
  report: "claude-haiku-4-5-20251001",
};

// In each phase call:
const result = await runQuery({
  ...opts,
  model: PHASE_MODELS[phaseName] ?? config.model,
});
```

Allow override via config:
```typescript
interface PipelineConfig {
  model: string;           // default model
  phaseModels?: {          // per-phase overrides
    parse?: string;
    research?: string;
    architect?: string;
    execute?: string;
    verify?: string;
    fix?: string;
    report?: string;
  };
}
```

## When to Use Opus

Opus is 5x more expensive than Sonnet but produces higher-quality reasoning. Use it strategically:

1. **Milestone 0 architect phase**: The foundational architecture decisions affect everything downstream. The $50-75 extra cost for Opus here could prevent architectural rework worth $200+ later.

2. **Complex fix cycles**: If a fix pass fails (attempt 3), switch to Opus for the final attempt before marking the milestone as blocked. The extra intelligence is worth the cost vs. pipeline failure.

3. **Never for verify/report**: These phases don't benefit from additional intelligence — they're mechanical tasks.

## Risk Considerations

- **Haiku for verify**: Haiku needs to correctly interpret compiler output and structured command results. Test this thoroughly — if Haiku misclassifies a failure as a pass, the pipeline could commit broken code.
- **Haiku for parse**: Haiku must produce valid JSON that matches the milestone schema. Validate the output programmatically rather than trusting the model.
- **Model availability**: Have a fallback strategy if a model is unavailable (degrade to the next tier up, not down).
