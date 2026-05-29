# pi-spend

A Pi package that adds a compact token/cost spend footer and `/pi-spend` report.

It separates telemetry display from handler-specific packages such as `pi-forks`.

## Footer

Example:

```text
◉ dialog 12k/$0.04 · ◆ agents 80k/$0.62 · ↯ forks 42k/$0.21 · ✦ mem 33k/$0.165 ctx · 35k/$0.175 full
```

Segments:

- `◉ dialog` — the current session JSONL token/cost usage.
- `◆ agents` — async subagent run token/cost totals for this dialog.
- `↯ forks` — related background fork-handler token/cost totals.
- `✦ mem` — observational-memory footprint.
  - `ctx` is the currently visible compaction-context memory.
  - `full` is the full active observational-memory ledger when larger.
  - memory dollars are estimated as input-context cost using the configured observational-memory model (`observational-memory.model` or legacy `observational-memory.compactionModel`), falling back to the current session model.

The dialog, agent, and fork dollar amounts come from recorded provider/Pi usage when available, so they reflect the model used by those calls.

## Commands

```text
/pi-spend    show the dialog/agent/fork/memory token and cost split
/spend       alias for /pi-spend
```

## Install

```bash
pi install git:github.com/dataforxyz/pi-spend
```

## Development

```bash
npm test
```
