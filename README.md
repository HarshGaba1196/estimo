# Estimo — Planning Poker

Real-time planning poker for agile teams. No sign-up, no dependencies, no build step.

```bash
node server.js        # http://localhost:3000  (PORT=8080 node server.js to change)
```

Requires Node 18+.

## Features

- **Instant rooms** — 6-character room codes and shareable `/r/CODE` links; rejoining keeps your seat.
- **Poker table** — players sit around a table, cards drop in as they vote and flip over on reveal. Phones and big teams get a grid layout.
- **Decks** — Fibonacci, Modified Fibonacci, T-shirt, Powers of 2, Hours, or a custom deck. Every deck has `?` and `☕` cards.
- **Results** — average, median, agreement %, a suggested card, a vote distribution chart, highlighted outliers ("lowest and highest voters, talk it out"), and confetti when everyone agrees.
- **Story backlog** — paste many stories at once (one per line; bullets and numbering are stripped). Reorder, rename, re-estimate. Saving an estimate moves to the next story. Running total of points, CSV export with each story's final votes.
- **Facilitation** — countdown timers that reveal at zero, auto-reveal when everyone has voted, nudges (a sound plus a shaking hand for whoever hasn't voted), observer role, hand off or claim the facilitator role, remove players. Facilitator role passes to someone else automatically if the facilitator stays disconnected for 45 s.
- **Permissions** — let anyone run the round, or only the facilitator.
- **Reactions** — click a teammate to throw an emoji across the table.
- **Keyboard first** — `1`–`9`/`0` vote, `←`/`→` move between cards, `Esc` withdraw, `R` reveal, `N` re-vote, `T` timer, `S` stories, `?` help.
- **Light and dark themes**, follows your system setting by default.
- **Persistence** — rooms are saved to `data/rooms.json` and survive restarts; rooms nobody touches for 7 days are removed.

## Architecture

| Piece | How |
| --- | --- |
| Server | `server.js`: plain `node:http`, in-memory rooms with debounced JSON persistence |
| Real-time | Server-Sent Events (`GET /api/rooms/:id/events`), each client gets its own view (votes stay hidden until reveal) |
| Actions | `POST /api/rooms/:id/action` with `{ token, type, ... }`, checked on the server |
| Identity | Each player gets a secret token (kept in localStorage) plus a public id; tokens are never broadcast |
| Client | `public/`: vanilla ES modules, keyed DOM updates for the seat animations |

To deploy behind a proxy, turn off response buffering for `/api/rooms/*/events` (nginx: `proxy_buffering off;`).
