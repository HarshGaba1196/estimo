# Estimo — Planning Poker

Real-time planning poker for agile teams. It runs entirely in the browser: no server, no accounts, no build step.

**Play:** https://harshgaba1196.github.io/estimo/

## How it works

1. Open the page, enter your name and click **Create room**.
2. Click **Invite** to copy the link and send it to your team.
3. They open the link, pick a name and avatar, and they're at the table.

Messages travel over free public MQTT brokers (EMQX, with HiveMQ as a fallback) on secure WebSockets. Every message is encrypted in the browser with a key derived from the room code, and topic names are a hash of the code, so the broker only sees scrambled data.

One tab in each room acts as the **hub**: it applies the room rules (`room.js`) and publishes the room state. Every other tab keeps a copy, so if the hub's tab closes, another player's tab takes over within a couple of seconds and nothing is lost. The state is also stored on the broker as a retained (encrypted) message, so reopening a room link after everyone has left brings the room back.

## Features

- **Poker table** — players sit around a table, cards drop in as they vote and flip over on reveal. Phones and big teams get a grid layout.
- **Decks** — Fibonacci, Modified Fibonacci, T-shirt, Powers of 2, Hours, or a custom deck. Every deck has `?` and `☕` cards.
- **Results** — average, median, agreement %, a suggested card, a vote distribution chart, highlighted outliers, and confetti when everyone agrees.
- **Story backlog** — paste many stories at once (one per line). Reorder, rename, re-estimate. Saving an estimate moves to the next story. Running point total and CSV export.
- **Facilitation** — countdown timers that reveal at zero, auto-reveal when everyone has voted, nudges, observer role, hand off or claim the facilitator role, remove players. The facilitator role passes to someone else if the facilitator is away for 45 s.
- **Reactions** — click a teammate to throw an emoji across the table.
- **Keyboard first** — `1`–`9`/`0` vote, `←`/`→` move between cards, `Esc` withdraw, `R` reveal, `N` re-vote, `T` timer, `S` stories, `?` help.
- **Light and dark themes**, following your system setting by default.

## Files

| File | What it does |
| --- | --- |
| `index.html`, `styles.css` | Page and styles |
| `app.js` | UI: rendering, dialogs, keyboard shortcuts, stats |
| `room.js` | Room rules (votes, stories, timers, permissions) |
| `realtime.js` | Encrypted MQTT transport, presence, hub election and takeover |

## Run locally

Any static file server works:

```bash
python3 -m http.server 4173
```

Then open http://localhost:4173. To test with two people on one machine, open one tab on `localhost` and another on `127.0.0.1` so they get separate storage.

## Deploy

GitHub Pages: repo **Settings → Pages → Build and deployment → Deploy from a branch → `main` / root**.

## Privacy note

Votes are hidden in the UI until reveal, but anyone who has the room code can decrypt the room's traffic, so a teammate inspecting network messages could see votes early. Treat the room link like a meeting link.
