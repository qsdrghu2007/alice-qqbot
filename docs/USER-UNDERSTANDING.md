# User Understanding

`src/user-understanding.js` maintains a small, local profile that helps Alice
understand a user's communication style across trusted private and group
contexts. It is independent from long-term memory and stays active when
`memory.enabled=false`.

## Scope And Privacy

- Only private messages from `onebot` and `qq` are collected. Group and web
  messages are never used as profile evidence.
- A user is identified by a SHA-256 key. The file stores no raw channel or
  account ID. `identityLinks` can intentionally map trusted identities to one
  key.
- A group turn may receive the current sender's safe profile. Other users'
  profiles and every private chat summary stay out of group prompts.
- Mutable profiles contain only fixed dimensions and enum values. Local model
  summaries are never injected into chat.
- Credentials, verification codes, contact details, accounts, and common token
  or plate formats are redacted before the daily AI request.
- The daily and weekly prompts exclude health diagnoses, religion, politics,
  sexual orientation, and other sensitive traits. Short-term emotion is not
  treated as a lasting temperament.
- The generated context starts with an instruction that current user facts and
  corrections win, Alice must keep her own judgment, and the profile must not
  be used to flatter, echo, or imitate the user.

## Schedule

At the configured local `hour:minute`, the scheduler processes complete natural
days. The default is 00:10 in `Asia/Shanghai`, so messages from 23:59 are
included when the prior day closes. Startup can recover pending days still in
the retention window. Each tick starts at most five sequential AI requests.

One daily request is made only for a user/day that contains at least one
message from that user. Alice-only days are never analyzed. A user's windows
start at their first collected day and each closed seven-day window makes at
most one weekly request, using only daily summaries from that window.

Normal chat AI is unchanged. The personality/profile analyzer is not called on
every message; it adds only the scheduled daily and weekly calls.

## Data Lifecycle

State is stored atomically in `data/user-understanding.json`, schema version 1,
with restrictive permissions. Raw daily text is bounded by message count,
character count, user count, and the retention period. Alice messages are
trimmed before user messages when a bound is reached.

After a successful daily summary, that day's raw text is deleted. Only the
short local summary and validated traits remain for the weekly pass. The daily
summary is not injected into chat. Expired daily and weekly data is pruned once
per local day, including while the feature is disabled.

Failed AI calls retain raw text until success or expiry. Retry count and the
last attempt time are persisted, with at most three attempts and at least five
minutes between them. A waiting daily retry keeps its seven-day window open.
Only after retries are exhausted may the weekly coverage record missing daily
evidence.

## Behavior And Failures

`recordTurn()` is serialized so concurrent turns are not lost. AI requests do
not hold the storage lock. `clearUser()`, `resetAll()`, and `stop()` advance an
epoch; an in-flight result from before that change cannot be committed.
`clearUser()` uses the current event's hashed identity, so the `/profile reset`
action removes the same shared safe profile in later private or group turns.

A malformed state file is renamed to a `.corrupt-<timestamp>` sibling, a fixed
warning is logged, and an empty state is used. Profile failures do not prevent
chat startup or message delivery.

## Configuration

The schema is owned by `src/config.js`:

```json
{
  "userUnderstanding": {
    "enabled": true,
    "hour": 0,
    "minute": 10,
    "timezone": "Asia/Shanghai",
    "judgeModel": "",
    "judgeTimeoutMs": 15000,
    "maxInputChars": 16000,
    "maxDailyMessages": 200,
    "maxUsers": 200,
    "retentionDays": 35,
    "maxInjectedChars": 1200
  }
}
```

AI is attempted only when the feature is enabled and the runtime has a real AI
endpoint/key, is not paused, and is not in demo mode. Collection starts after
the feature is enabled; the module does not backfill real logs.
