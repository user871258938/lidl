# Changelog — lidl-extender

## 2026-10-04 — Working tree

Changes after `v1.2.5`.

### ⚡ Speed-adaptive check intervals

The main Lidl page check/reload interval now adapts to the configured internet speed.

```env
INTERNET_SPEED_MBPS=500
```

* Default/reference speed: `500 Mbps`
* Empty or unset values fall back to `500 Mbps`
* Scaling factor: `500 / speed`
* Scaling is clamped to `0.5–3.0`
* Slower connection → longer wait
* Faster connection → shorter wait

The existing data-volume intervals are scaled automatically instead of using the same timing for every connection.

The interval controls **when the next page check occurs**. It is separate from page-load/navigation timeouts.

### 🎲 Jittered scheduling

A random **0–50% additive jitter** is applied to the calculated interval.

The interval can therefore be extended, but never shortened.

Example:

```text
Calculated interval: 30 s
Actual interval:     30–45 s
```

This avoids identical, repeating check times while preserving the calculated minimum wait.

### 🔎 More resilient Lidl data parsing

Lidl has changed the DOM structure used for consumption data. Newer versions use identifiers such as:

```text
progress-DATA-0
progress-REFILL
```

instead of the older:

```text
DATA
REFILLABLE_DATA
```

`readConsumptionUsage(page)` now handles both through a fallback chain:

1. exact known selectors
2. prefix-based selectors
3. positional matching inside `.app-consumption-list`

Additional parsing improvements:

* waits until consumption labels contain actual text
* supports German decimal separators such as `12,5 GB`
* reads the unit value from the corresponding `unit` element
* uses the same parser before and after refill
* avoids invalid `NaN` totals when refill data is unavailable

### 🛠 Configuration and metadata fixes

* synchronized `package.json` and `package-lock.json` to `1.2.5`
* fixed the `INFOLEVEL` / `INFO_LEVEL` mismatch
* `INFOLEVEL` remains supported for existing configurations

---

# v1.2.5 — 80% refill refactor

Original repository state:

```text
ff1d451
```

### 🔄 Refill trigger changed to 80% usage

The previous refill condition waited until less than approximately **1 GB** remained.

The new logic triggers refill at **80% total consumption**.

```text
REFILL_USAGE_THRESHOLD = 0.8
```

A refill is attempted when:

* 80% of the tariff volume has been consumed
* refill data is available
* the retry cooldown has expired

This keeps approximately **20% of the original tariff volume as a data buffer** under normal operation instead of waiting until the remaining volume is nearly exhausted.

Failed refill attempts now set `refillFailedAt`, making the existing **10-minute retry cooldown** effective.

### 📈 Adaptive checking near the refill threshold

The check interval adapts to the current state instead of remaining fixed.

It considers:

* available data volume
* current consumption
* proximity to the 80% threshold

As consumption approaches 80%, checks become more frequent and can reach a minimum of **30 seconds**.

Scheduling uses recursive `setTimeout` rather than a fixed `setInterval`.

### 📊 80% progress reporting

Added `buildRefillProgressLine(usage)` to show how close the current consumption is to the refill threshold.

```text
⏳ WAITING FOR 80%
used 18.2/26.0 GB (70%)
[██████████████████░░]
88% of 80% used · to 80%: 2.6 GB
```

At the threshold:

```text
🔄 RECHARGING NOW
used 20.8/26.0 GB (80%)
[████████████████████]
100% of 80% used
```

The progress information is included in status/success output and the existing Telegram and Discord notifications.

### 🐛 Runtime and navigation fixes

* changed login navigation from `networkidle` to `domcontentloaded`
* fixed `.env` path handling with `fileURLToPath`
* `HEADLESS=false` is now respected
* fixed post-refill reading of `refill.available`
* prevented missing refill data from creating `NaN` totals
* broadened the selector used while waiting for consumption data

### ❤️ Watchdog / heartbeat

Fixed false `Deadlock` detections during intentional long waits.

* added a 30-second heartbeat timer
* added `isRestarting` to prevent overlapping restarts
* `restartBrowser()` updates the heartbeat immediately

This prevents unnecessary browser restarts and duplicate watchdog notifications while the script is legitimately waiting.

### 💬 User-facing messages

Status and success messages now provide clearer runtime information.

Added:

* `📡 Lidl-Extender` header
* 80% consumption progress
* human-readable duration formatting

For example:

```text
Nächste Prüfung in 83 Min.
Nächste Prüfung in 1 Std. 25 Min.
```

Raw seconds/milliseconds are no longer shown in user-facing duration messages.

---

