# spen-wa-webhook

SPEN WhatsApp insights over Evolution API, now with up to 3 connected numbers ("lines").

- `GET /connect` : scan QR (or get a pairing code) for each line. Missing Evolution instances are created automatically.
- `GET /lines` : connection status of every line.
- Line 1 keeps the legacy routes (`/insights`, `/chats`, `/search`...). Lines 2 and 3: `/line/2/insights`, `/line/3/chats`, etc.
- `/groups` and `/groups/members` accept `?line=2`.
- Daily 05:00 import runs every connected line; tasks from lines 2/3 end with `[Line N]`.

Env: `EVO_INSTANCES` (default `<EVO_INSTANCE>,<EVO_INSTANCE>-2,<EVO_INSTANCE>-3`), optional `CONNECT_KEY` to lock `/connect` and `/lines` behind `?key=`.
