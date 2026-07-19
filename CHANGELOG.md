# Changelog

## Unreleased

- Add `/pi-cost-config`, a toggle menu for dialog, agent, fork, memory, and last-message footer metrics. Changes affect only the current Pi instance unless `Ctrl+S` saves them as the global default. Disabled metrics skip their footer scans, and disabling every spend metric stops the refresh timer.
- Show the latest user/assistant message time in the existing spend footer, without adding a timer, polling, or API work.
- Hide fork spend unless the `pi-forks` extension is enabled, and report forks as disabled instead of counting stale handler state.

## 0.1.0

- Initial pi-spend package with spend footer and `/pi-spend` command.
