# Omi → Apple Notes

Talk to Omi, get a note in Apple Notes.

> "Omi, start a camping list with tent, sleeping bags and a head torch."
> "Omi, add tent pegs and a gas canister to my camping list."
> "Omi, what's on my camping list?"

## Why it is built this way

Apple Notes has **no cloud API**. The only supported way to write a note is AppleScript/JXA
running on an Apple device signed into that iCloud account. Omi, meanwhile, is cloud-side: it
invokes chat tools over HTTPS. So this is a two-part system.

```
  You speak
      │
      ▼
  Omi assistant ──invokes chat tool──▶  relay (Railway, public HTTPS)
                                            │  queue + note mirror (SQLite)
                                            │
                    long-poll ◀─────────────┘
                        │
                        ▼
              agent (your Mac, launchd)
                        │  JXA
                        ▼
                  Apple Notes
```

* **`relay/`** — public HTTPS service. Serves the Omi tool manifest, accepts tool calls,
  queues the writes, and answers read tools instantly from a mirror of your note titles and
  bullets. Zero runtime dependencies (`node:sqlite`, `node:http`).
* **`agent/`** — a small daemon on your Mac. Holds a long poll open against the relay, so a
  spoken command reaches Apple Notes in about a round trip, and applies it with JXA.

Writes are queued, so if your Mac is asleep Omi says *"I'll write this as soon as your Mac is
back online"* rather than failing. Reads are served from the mirror, so *"what's on my camping
list?"* answers even when the Mac is off.

## Tools Omi gets

| Tool | Spoken example |
| --- | --- |
| `create_note` | "start a packing list with passport and charger" |
| `add_to_note` | "add tent pegs to my camping list" |
| `remove_from_note` | "take the head torch off the camping list" |
| `read_note` | "what's on my camping list?" |
| `list_notes` | "what notes do I have?" |

There is deliberately **no delete-note tool**. The agent has no code path that deletes a note.

Titles are matched loosely, so "my camping list" finds a note actually called **Camping Kit**.
`add_to_note` takes an optional `section`, so "add a spare wheel under Trailer" lands under
that heading rather than at the end.

## How it actually reaches Omi

Three routes exist; only the third works for a Mac push-to-talk user.

| Route | Status |
| --- | --- |
| Chat tools (`/.well-known/omi-tools.json`) | Built and tested, but Omi builds without a "Chat Tools Manifest URL" field cannot use it |
| Trigger webhooks (`/omi/webhook`) | Built and tested, but only fire on **captured conversations** — never on push-to-talk chat |
| **Polling Omi chat** | **Works.** The Mac agent reads chat history and acts on it |

The catch that forced this: when you type or speak a note command, Omi answers *"Update
Camping List started and is working in the background"* and then does nothing — that is
Omi's own background agent, which cannot write to Apple Notes (it fails the same way on
Notion). It never makes an outbound call, so no webhook or tool of ours is ever invoked.

So the agent polls `get_chat_messages` over Omi's MCP endpoint every 15 seconds — the only
place chat history is exposed, as there is no REST endpoint and no CLI command for it — and
applies any note command it finds. Ignore Omi's "working in the background" reply; the note
appears regardless.

Chat messages are already addressed to Omi, so no wake word is required there. Speech-to-text
mangles it anyway: real messages have arrived as *"Omit Add Ten Pegs"* and *"Ome Add A
Generator"*, and a leading mis-hearing is stripped.

On first run the agent starts watching from that moment, so your existing chat history is
never replayed.

## Setup

Only the Mac agent is needed. The cloud relay is **not deployed** — see below.

```bash
./scripts/install-agent.sh
```

Then put your Omi MCP key in `~/.config/omi-notes/config.env` (mode 600):

```
OMI_MCP_URL=https://api.omi.me/v1/mcp/sse
OMI_MCP_KEY=omi_mcp_...
```

Installing runs the agent once in the foreground first, which is what makes macOS show the
**Automation → Notes** prompt — a launchd-started process cannot surface that dialog
reliably. Approve it when it appears.

```bash
tail -f ~/Library/Logs/omi-notes/agent.log   # watch it work
./scripts/reload-agent.sh                    # rebuild + restart after code changes
./scripts/uninstall-agent.sh                 # remove the service
```

`reload-agent.sh` matters: Node loads `dist/` once at startup, so rebuilding alone leaves the
old code running under launchd.

### Say this

| Say | Result |
| --- | --- |
| "Omi, add tent pegs and a gas canister to my camping list" | two items appended |
| "Omi, start a packing list with passport and charger" | new note created |
| "Omi, create a new list called Wiston" | note named Wiston |
| "Omi, take the head torch off my camping list" | item removed |

Titles match loosely, so "my camping list" finds a note called **Camping Kit**.

Omi's own assistant replies "…started and is working in the background" and does nothing —
and may fail outright with a billing error. Neither matters: the agent reads your chat
messages directly and never depends on Omi's AI answering.

### The relay (not deployed)

`relay/` is a complete, tested HTTPS service that serves an Omi chat-tools manifest and
accepts trigger webhooks. It was deployed to Railway, verified end to end, and then torn
down on 2026-08-31 because **neither route reaches a push-to-talk user** — see above. The
code is kept for Omi builds that gain a chat-tools manifest field; deploy it with a
Dockerfile build, a volume at `/data`, and `AGENT_TOKEN` + `PUBLIC_BASE_URL` set. Set
`RELAY_URL` and `AGENT_TOKEN` in the agent config to switch it back on; leave them unset and
the agent runs on chat polling alone.

## Known limits

* **No real checkboxes.** Apple Notes strips `class` attributes from scripted HTML, so
  AppleScript cannot create tappable checklists — only bullets. (Verified, not assumed.) Your
  existing notes already use bullets, so appended items match them exactly.
* **Your Mac must be awake** for a write to land. Until then it sits in the queue.
* **Loose title matching cuts both ways.** "my list" is vague enough to hit the wrong note.
  On a tie the most recently edited note wins. Matching is token-based, never raw substring
  — a note called "4176" must not claim "Omi E2E 1788164176", which it once did.
* The mirror carries the 60 most recently modified notes in full, and titles for up to 300.
* Apple Notes exposes **Recently Deleted as an ordinary folder**, so it is excluded explicitly
  — otherwise Omi could append to a note you had already deleted. The folder name is
  localised; override it with `EXCLUDE_FOLDERS` on a non-English system.

## Development

```bash
cd agent && npm test        # unit tests for the HTML and title-matching layers
./scripts/e2e-local.sh      # boots relay + agent locally, drives the real Omi HTTP calls
./scripts/verify-live.sh    # drives the DEPLOYED relay + the running Mac agent
./scripts/reload-agent.sh   # rebuild + restart the launchd service
```

`reload-agent.sh` matters: Node loads `dist/` once at startup, so rebuilding alone leaves the
old code running under launchd. A stale agent is what once sent a live check into an
unrelated note.

`verify-live.sh` pins a throwaway uid on the relay, so it always resets it afterwards —
otherwise trust-on-first-use would lock your real Omi account out.

`e2e-local.sh` creates a uniquely-named sandbox note in Apple Notes, exercises every tool
against it, and moves it to Recently Deleted afterwards (`KEEP_NOTE=1` to keep it).

Note bodies are edited surgically rather than regenerated, so a note you have hand-formatted
keeps its structure, spacing and styling when Omi appends a line to it.
