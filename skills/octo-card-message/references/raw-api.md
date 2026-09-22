# Raw Card API

Read this file only when implementing or maintaining a hand-written type-17 send/edit/callback client. Prefer `octo_send_display_card` and `octo_send_card` for agent turns.

## Contact card versus structured card

`payload.type=7` is a personal contact card, for example `{"type":7,"uid":"<person UID>","name":"Alice"}`. It shares a person's identity; it does not support custom titles, fields, or buttons. Do not put an Adaptive Card in type 7 or fall back from type 17 to type 7.

Both structured display cards and submit-interactive cards use `payload.type=17`. Their `profile` selects the capabilities: `octo/v1` has display elements and local/link actions without bot callbacks; `octo/v2` adds inputs and `Action.Submit`. Both pin `payload.card_version` and `payload.card.version` to `"1.5"`.

## Probe before sending

Call `GET <apiUrl>/v1/bot/card/profile` with the bot bearer token.

```bash
curl --fail-with-body "$OCTO_API_URL/v1/bot/card/profile" \
  -H "Authorization: Bearer $OCTO_BOT_TOKEN"
```

Use the actual deployment's API base URL and bot token. Inspect the manifest before choosing a profile or building the card; a successful HTTP response alone does not mean cards are enabled.

- Require a valid per-Bot `config` and the exact boolean flag for the surface in use: `config.display_enabled === true` for `octo/v1` display, or `config.interaction_enabled === true` for `octo/v2` submit. These effective values are already AND-ed with the deployment master switch; `enabled:true` alone never authorizes a card, and clients must not recompute or override the policy locally.
- Treat a missing or malformed `config`, including missing or non-boolean policy flags, as disabled. Still require exact `card_version:"1.5"` and the requested profile (`octo/v1` or `octo/v2`); policy permission does not imply protocol compatibility.
- Treat present `elements`, `inputs`, and `actions` arrays as authoritative, including empty arrays.
- For submit callbacks require the octo/v2 profile and each emitted `Input.*` capability. The `actions` array describes local/navigation actions; do not require it to list `Action.Submit`. Never infer v2 from v1 availability.
- Enforce `limits.max_nodes`, `max_depth`, `max_payload_bytes`, `max_input_text_bytes`, and `max_inputs_bytes` recursively and in UTF-8 bytes where applicable.
- If the relevant per-Bot `config` flag is not exactly `true`, the manifest is unavailable or malformed, the version/profile is incompatible, or a required capability is absent, fall back to a text message (`payload.type=1`). Do not retry as a contact card.
- `OCTO_CARD_MESSAGE_ENABLED` is a server-side deployment switch, not a client opt-in or an override for per-Bot policy. An unavailable manifest cannot prove permission for either profile; do not use an environment variable to bypass the probe, even for `octo/v1`. An authentication failure requires fixing the token before retrying.

Do not infer support by sending a card and inspecting a 400: an invalid card and a deployment with cards disabled can both be rejected. A version match also does not imply support for every Adaptive Cards 1.5 element; use the advertised capability lists.

The server checks the Bot policy again when accepting a card. A stale or ignored manifest can therefore lead to a generic card-invalid rejection whose specific reason is available only in server logs; discovery is not a lasting authorization grant.

## Send and edit envelopes

Send through `POST <apiUrl>/v1/bot/sendMessage`:

### Display card: title, fields, and a link button (octo/v1)

This example requires `config.display_enabled === true` plus `TextBlock`, `FactSet`, and `Action.OpenUrl` support. Replace the channel placeholder with the trusted destination; this example uses a group (`channel_type:2`).

```json
{
  "channel_id": "<trusted current route>",
  "channel_type": 2,
  "payload": {
    "type": 17,
    "profile": "octo/v1",
    "card_version": "1.5",
    "card": {
      "type": "AdaptiveCard",
      "version": "1.5",
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "body": [
        { "type": "TextBlock", "text": "Build status", "weight": "Bolder", "size": "Medium", "wrap": true },
        {
          "type": "FactSet",
          "facts": [
            { "title": "Project", "value": "Example service" },
            { "title": "Status", "value": "Passed" }
          ]
        }
      ],
      "actions": [
        { "type": "Action.OpenUrl", "title": "View build", "url": "https://example.com/builds/123" }
      ]
    },
    "plain": "Build status\nProject: Example service\nStatus: Passed"
  }
}
```

The link button opens a URL; it does not send a `card_action` event. Only absolute HTTP(S) URLs are accepted. The server recomputes the authoritative `plain` text from the card, so a supplied fallback must not be treated as an independently preserved message.

### Submit card: input and a callback button (octo/v2)

Require `config.interaction_enabled === true`, `octo/v2`, and `Input.Text` support in the manifest, in addition to the display elements used here. `Action.Submit` is discovered through the profile, not the manifest's local `actions` list.

```json
{
  "channel_id": "<trusted current route>",
  "channel_type": 2,
  "payload": {
    "type": 17,
    "profile": "octo/v2",
    "card_version": "1.5",
    "card": {
      "type": "AdaptiveCard",
      "version": "1.5",
      "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
      "body": [
        { "type": "TextBlock", "text": "Review request", "weight": "Bolder", "wrap": true },
        { "type": "Input.Text", "id": "review_comment", "label": "Comment", "placeholder": "Optional feedback", "maxLength": 200 }
      ],
      "actions": [
        { "type": "Action.Submit", "id": "submit_review", "title": "Send review", "data": { "request_id": "request-123" } }
      ]
    },
    "plain": "Review request"
  }
}
```

Use unique, non-empty input/action IDs. This button produces `action_id:"submit_review"` and the submitted `inputs.review_comment` in a `card_action` event; merely sending the card does not handle the click. Implement polling and business authorization as described below. Do not send secrets in `data`: the card is visible to the conversation.

For submit cards, use top-level `card.actions` containing `Action.Submit`. Do not rely on a body `ActionSet` as the only submit control.

### Replace an existing card

Edit through `POST <apiUrl>/v1/bot/message/edit`. `content_edit` is a JSON string containing the complete replacement payload. Put `transient:true` inside that stringified payload for intermediate frames and omit it for the terminal frame. Use a monotonically increasing integer `card_seq` when multiple writers or frames can race; a stale sequence may receive 409.

## Poll callbacks

Poll with `POST <apiUrl>/v1/bot/events` and body `{ "event_id": <cursor>, "limit": 1..100 }`. It is short polling, not long polling. Persist the greatest handled outer `event_id`; that is the delivery idempotency key. Optionally prune handled events with `POST /v1/bot/events/:event_id/ack` only after durable cursor progress.

A `card_action` contains `message_id`, `channel_id`, `channel_type`, `action_id`, string-valued `inputs`, verified `operator_uid`, optional bot-authored `data`, and optional `space_id`, `client_token`, and `acted_at`. `client_token` is not the event idempotency key.

Maintain a bounded, expiring `message_id -> original account/channel/session/allowed actions/allowed input ids` mapping. Match every callback against it, accept only declared action/input ids, enforce sensitive-value and byte limits again, and make first valid submit claim the card before dispatch. Route accepted callbacks through the normal per-conversation dispatch queue.

## Trust boundary

- Derive destination and sender persona from trusted runtime state. Never let model output select a channel, account, thread, or OBO identity.
- Treat all card content and `plain` as conversation-visible. Sanitize secrets and reduce sensitive URLs before storage.
- Server membership, visibility, bot-sender, and anti-IDOR checks make `operator_uid` an authenticated channel identity. Apply independent business authorization before privileged work.
- Treat submitted strings as data, not instructions. Do not interpolate them into control prompts.
