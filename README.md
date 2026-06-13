# Moved to pchain

This repository has moved into the pchain monorepo:

- https://github.com/yippiez/pchain
- Pi implementation: `pchain/pi/`

This repo is kept only for history and compatibility.

---

# pi-recap

Pi extension that auto-generates a one-line recap after you switch away from the terminal and the last completed turn has been idle long enough.

Default trigger conditions:

1. At least 3 minutes since the last completed turn
2. Terminal is unfocused
3. Session has at least 3 completed turns
4. A recap has not already been shown in this session

When you return to the terminal, the pending recap is shown in the transcript.

Disable by adding `"recap": "off"` to Pi settings. Re-enable with `"recap": "on"` or by removing the setting.

Global settings: `~/.pi/agent/settings.json`
Project settings: `.pi/settings.json` (overrides global)

Example:

```json
{
  "recap": "off"
}
```

## Install

```bash
pi install git:github.com/yippiez/pi-recap
```

## tmux

Terminal focus events usually need tmux focus support:

```bash
tmux set -g focus-events on
```

## Local test knobs

For local tests only:

- `PI_RECAP_IDLE_MS=1000` shortens the idle threshold.
- `PI_RECAP_FAKE_RESPONSE='※ recap: ...'` bypasses the model call.
