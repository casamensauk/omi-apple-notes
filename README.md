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

## Setup

The relay is already deployed at **https://relay-production-a11d.up.railway.app** (Railway
project `omi-notes-relay`, building from this repo with root directory `/relay` and a volume
at `/data`).

### 1. Finish the wiring

```bash
./scripts/finish-setup.sh
```

This logs into Railway if needed, pushes your `AGENT_TOKEN` from
`~/.config/omi-notes/config.env` **over stdin** so it never lands in a command line or a log,
waits for the relay to report `agentConfigured: true`, then installs the Mac agent and
smoke-tests the path.

Installing the agent runs it once in the foreground first, which is what makes macOS show the
**Automation → Notes** prompt — a launchd-started process cannot surface that dialog
reliably. Approve it when it appears.

### 2. Register the app with Omi

In the Omi app, create an app with the **External Integration** capability pointing at:

```
https://relay-production-a11d.up.railway.app/.well-known/omi-tools.json
```

The first tool call pins your Omi `uid`; every later call from a different uid is refused. To
be stricter, set `ALLOWED_UIDS` (and `OMI_APP_ID`) on the relay.

### 3. Try it

> "Omi, add tent pegs and a gas canister to my camping list."

```bash
tail -f ~/Library/Logs/omi-notes/agent.log   # watch it land
./scripts/uninstall-agent.sh                 # remove the service
```

Health check: `curl https://relay-production-a11d.up.railway.app/health` →

```json
{"ok":true,"pending":0,"agentConfigured":true,"mirrorNotes":305,"mirrorAgeSeconds":42}
```

`mirrorNotes: 0` means the Mac agent has never synced; a large `mirrorAgeSeconds` means it
has stopped. Both are answerable without log access.

The relay starts even with no `AGENT_TOKEN` set — it serves `/health` and the manifest and
refuses the agent endpoints with a 503 saying why, rather than crash-looping on missing
config. `agentConfigured: false` is how you spot it.

## Known limits

* **No real checkboxes.** Apple Notes strips `class` attributes from scripted HTML, so
  AppleScript cannot create tappable checklists — only bullets. (Verified, not assumed.) Your
  existing notes already use bullets, so appended items match them exactly.
* **Your Mac must be awake** for a write to land. Until then it sits in the queue.
* **Loose title matching cuts both ways.** "my list" is vague enough to hit the wrong note.
  On a tie the most recently edited note wins.
* The mirror carries the 60 most recently modified notes in full, and titles for up to 300.
* Apple Notes exposes **Recently Deleted as an ordinary folder**, so it is excluded explicitly
  — otherwise Omi could append to a note you had already deleted. The folder name is
  localised; override it with `EXCLUDE_FOLDERS` on a non-English system.

## Development

```bash
cd agent && npm test        # unit tests for the HTML layer
./scripts/e2e-local.sh      # boots relay + agent locally, drives the real Omi HTTP calls
```

`e2e-local.sh` creates a uniquely-named sandbox note in Apple Notes, exercises every tool
against it, and moves it to Recently Deleted afterwards (`KEEP_NOTE=1` to keep it).

Note bodies are edited surgically rather than regenerated, so a note you have hand-formatted
keeps its structure, spacing and styling when Omi appends a line to it.
