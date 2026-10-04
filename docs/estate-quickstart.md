# Dedicated estate quickstart

For Operator and Sovereign accounts whose dashboard shows the estate as **ready**. Everything below
goes through the console gateway, `https://force-field-console.netlify.app/api/v1/<service>/...`, with
your console API key in `x-api-key`. The gateway strips `/api/v1`, adds the estate's own perimeter
secret, and forwards your `x-field-*` / `x-force-*` headers (never cookies, `Authorization`, or a
caller-supplied `x-field-auth`). Responses are buffered; requests time out after 30 s.

The estate is a Force Field Protocol engine: thirteen services behind one origin, in the armed
posture (per-event ledger signing required, served attestations signed, gateway enforcement with
tool checks, and a delegation roster that gates every mint). The dashboard shows the public keys and
fingerprints you need to verify anything it produced off-box.

## 0. Before the first call

1. **Roster scopes.** On the dashboard, save the scopes your agents may be delegated (one per line),
   the longest token you will mint, and an optional spend ceiling. Until at least one scope is
   saved, your row is left off the estate's roster and no token can be minted under your name.
2. **Anthropic key** (only for governed LLM calls): place your own key on the dashboard. It is set
   as a secret on your estate and never stored by the console.
3. **API key**: create one on the dashboard. Rate limits are per tier (see the pricing table).

Set these for the examples:

```sh
export FF=https://force-field-console.netlify.app/api/v1
export FF_KEY=ff_live_...            # your console API key
export ME=you@example.com            # your account email = your grantor / owner string
```

## 1. Register an agent

The owner must be a human — use your account email, which is also on the estate's owner roster
(the daily lifecycle sweep escalates agents whose owner is not on it; it never kills anything).

```sh
curl -s -X POST "$FF/registry/agents" -H "x-api-key: $FF_KEY" -H "content-type: application/json" \
  -d '{"agent_id":"invoice-bot","name":"Invoice bot","owner":"'"$ME"'","domain":"finance"}'
```

`agent_id` is a slug (`^[a-z0-9][a-z0-9._-]*$`). Add `"manifest_ref"` when the agent has a FIELD
manifest on the estate; a ref that does not resolve is refused with 422.

## 2. Mint a delegation token

`granted_by` must equal your grantor string exactly (your account email), the scopes must be a
subset of the scopes you saved on the dashboard, and the TTL must not exceed the longest token you
allowed there.

```sh
curl -s -X POST "$FF/delegation/tokens" -H "x-api-key: $FF_KEY" -H "content-type: application/json" \
  -d '{"agent_id":"invoice-bot","granted_by":"'"$ME"'","scope":["draft invoice"],"ttl_seconds":86400}'
```

The answer carries `token_id`; keep it with the agent. Refusals are explicit: `403 D.grantor` (not on
the roster, inactive, or a scope you may not delegate), `422 D.scope` (outside the agent's manifest),
`403` on a TTL past your ceiling. Every mint and revoke is a signed ledger event.

Revoke: `POST $FF/delegation/tokens/<token_id>/revoke`.

## 3. Check an action before taking it

```sh
curl -s -X POST "$FF/sentinel/check" -H "x-api-key: $FF_KEY" -H "content-type: application/json" \
  -d '{"agent_id":"invoice-bot","action":"draft invoice","token_id":"<token_id>"}'
```

The verdict is `ALLOW`, `BLOCK` or `ESCALATE` with the reason code (`R.unregistered`, `D.scope`,
`E.kill_switch`, `E.spend_cap`, `E.rate_limit`, `L.unreachable`, ...). A `BLOCK` is itself a ledger
event.

## 4. Make a governed LLM call

The estate's gateway is an Anthropic-Messages-shaped endpoint that checks identity and authority on
every call before it forwards anything (and refuses with 401 when the identity headers are missing):

```sh
curl -s -X POST "$FF/gateway/v1/messages" -H "x-api-key: $FF_KEY" -H "content-type: application/json" \
  -H "x-field-agent-id: invoice-bot" -H "x-field-token: <token_id>" -H "x-field-action: draft invoice" \
  -d '{"model":"claude-haiku-4-5","max_tokens":200,"messages":[{"role":"user","content":"Draft a two-line invoice note."}]}'
```

`x-field-action` names the action the sentinel checks (it must be inside the token's scope);
`x-force-preset` selects a FORCE prompt-hygiene preset. Token usage is metered to the agent's spend
cap on the governor. Without an Anthropic key on the estate the upstream call answers 502.

## 5. Download an attestation pack and verify it off-box

```sh
curl -s "$FF/attest/pack?period=2026-Q3" -H "x-api-key: $FF_KEY" > board-pack.json
curl -s "$FF/attest/pack.html?period=2026-Q3" -H "x-api-key: $FF_KEY" > board-pack.html
```

The served pack is signed with the estate's attestation key (its fingerprint is on the dashboard;
the public key is there too). Verify with the engine's CLI from the public repository
`SpinStateLabs/field-platform`:

```sh
attest verify board-pack.json --pubkey attest-sign.pub.pem
```

Every metric in the pack carries the ledger query that produced it, so any number can be re-run.

## 6. Read the ledger and the registry

```sh
curl -s "$FF/ledger/health" -H "x-api-key: $FF_KEY"          # signing: on, require_signing, appendable, key fingerprint
curl -s "$FF/registry/agents" -H "x-api-key: $FF_KEY"
curl -s "$FF/lifecycle/findings" -H "x-api-key: $FF_KEY"     # the daily sweep's report (404 before the first sweep)
```

The ledger's `key_fingerprint` must equal the `ledger-sign` fingerprint on your dashboard; it was
generated inside your estate at bootstrap and the private key never leaves it.

## What the console does to your estate, and what it does not

- It **never** reads your ledger contents, your keys, or your Anthropic key.
- A scheduled check every two minutes looks at `/ledger/health` and flags a problem on the
  dashboard; it never stops, restarts or destroys the estate.
- When Spin State Labs publishes a new engine image (smoked on the public sandbox first), your
  estate follows it: one machine update in the armed posture, then the posture and your ledger's
  signing key are re-verified; a failure halts the rollout for your estate and shows on the
  dashboard.
- A cancelled subscription stops the machine and keeps the volume; destroying an estate is a manual
  operator action, never automatic.
- The three platform self-agents inside your estate (sentinel, gateway, crosswalk) renew their own
  30-day tokens automatically after 25 days, with one brief restart.
