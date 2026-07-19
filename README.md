# pi-spend

A Pi package that adds a compact token/cost spend footer and `/pi-spend` report.

It separates telemetry display from handler-specific packages such as `pi-forks`.

## Footer

Example:

```text
◉ dialog 12k/$0.04 · ◆ agents 80k/$0.62 · ↯ forks 42k/$0.21 · ✦ mem 33k/$0.165 ctx · 35k/$0.175 full · ◷ last 20:44
```

Segments:

- `◉ dialog` — the current session JSONL token/cost usage.
- `◆ agents` — subagent token/cost totals for this dialog, including modern `pi-subagents` background handler sessions and legacy async run status files.
- `↯ forks` — related non-agent background fork-handler token/cost totals (`pi-intercom` and `pi-return-on`), shown only when the `pi-forks` extension is enabled in Pi settings.
- `✦ mem` — observational-memory footprint.
  - `ctx` is the currently visible compaction-context memory.
  - `full` is the full active observational-memory ledger when larger.
  - memory dollars are estimated as input-context cost using the configured observational-memory model (`observational-memory.model` or legacy `observational-memory.compactionModel`), falling back to the current session model.
- `◷ last` — local time of the latest user or assistant message. Tool-result plumbing is ignored. Older messages include the date.

The last-message display adds no timer, file polling, or model/API work. It updates from Pi's existing message lifecycle events and piggybacks on the footer that `pi-spend` already maintains.

## Footer configuration

Run `/pi-cost-config` to open a toggle menu for:

- Dialog usage
- Agent runs
- Fork handlers
- Memory context
- Last message time

Toggle changes apply immediately to the **current Pi instance only**. Press `Ctrl+S` inside the menu to save the current choices as the global default in `~/.pi/agent/pi-spend.json` (or the directory selected by `PI_CODING_AGENT_DIR`). New instances and instances that run `/reload` use that saved default; already-running instances are not changed automatically.

Unsaved choices last for the current instance and are discarded by `/reload` or restart. Disabled spend metrics are not scanned during footer refreshes. If every spend metric is disabled, the periodic refresh timer is stopped; the last-message time can still update from lifecycle events.

The dialog, agent, and fork dollar amounts come from recorded provider/Pi usage when available, so they reflect the model used by those calls. Fork state is ignored when `pi-forks` is not enabled, so old handler state files cannot be reported as live fork spend; `/pi-spend` reports `forks: disabled (pi-forks not enabled)` in that case. Expensive all-spend scans show a temporary footer progress indicator and reuse a short-lived in-memory report cache; individual JSONL token parses are cached by file size/mtime on disk.

## Commands

```text
/pi-cost-config  configure which metrics appear in the footer
/pi-spend        show this dialog's dialog/agent/fork/memory token and cost split
/pi-spend --all  show all known spend by category: all session JSONL dialog usage, all subagents, all non-agent forks, and current-branch memory
/pi-spend-all    alias for /pi-spend --all
/spend           alias for /pi-spend
```

## Install

```bash
pi install git:github.com/dataforxyz/pi-spend
```

## Development

```bash
npm test
```
