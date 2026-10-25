// Planning Poker server — zero dependencies.
// Real-time updates via Server-Sent Events, actions via JSON POST.
import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const ROOM_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOST_HANDOFF_MS = 45 * 1000;

export const DECKS = {
  fibonacci: { name: 'Fibonacci', cards: ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '?', '☕'] },
  modified: { name: 'Modified Fibonacci', cards: ['0', '½', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'] },
  tshirt: { name: 'T-Shirt sizes', cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'] },
  powers: { name: 'Powers of 2', cards: ['0', '1', '2', '4', '8', '16', '32', '64', '?', '☕'] },
  hours: { name: 'Hours', cards: ['1', '2', '4', '8', '12', '16', '24', '32', '40', '?', '☕'] },
};
const REACTIONS = ['👍', '🎉', '🤔', '😂', '🔥', '❤️', '👀', '🚀', '🍅', '✈️'];
const AVATARS = ['🦊', '🐼', '🐨', '🦁', '🐯', '🐸', '🐙', '🦄', '🐝', '🦉', '🐧', '🐳', '🦖', '🐢', '🦩', '🐱'];

/** @type {Map<string, any>} */
const rooms = new Map();
/** token -> { roomId, playerId } */
const tokens = new Map();
/** roomId -> Set<{ res, playerId }> */
const clients = new Map();
const roomTimers = new Map();
const hostHandoffTimers = new Map();

const uid = () => crypto.randomBytes(9).toString('base64url');
const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function roomCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(6), (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
  } while (rooms.has(code));
  return code;
}

function parseCustomDeck(input) {
  const cards = [...new Set(String(input ?? '').split(/[,\s]+/).map((c) => str(c, 5)).filter(Boolean))].slice(0, 20);
  return cards.length >= 2 ? cards : null;
}

function resolveDeck(deckId, custom) {
  if (deckId === 'custom') {
    const cards = parseCustomDeck(custom);
    if (cards) return { id: 'custom', name: 'Custom', cards };
  }
  const d = DECKS[deckId] ?? DECKS.fibonacci;
  return { id: DECKS[deckId] ? deckId : 'fibonacci', name: d.name, cards: [...d.cards] };
}

// ---------- persistence ----------
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(DATA_FILE, JSON.stringify([...rooms.values()]));
    } catch (err) {
      console.error('Failed to save rooms:', err.message);
    }
  }, 1000);
}

function loadRooms() {
  if (!existsSync(DATA_FILE)) return;
  try {
    const list = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
    for (const room of list) {
      room.timer = null;
      room.revealed = room.revealed ?? false;
      rooms.set(room.id, room);
      for (const p of Object.values(room.players)) {
        p.conns = 0;
        tokens.set(p.token, { roomId: room.id, playerId: p.id });
      }
    }
    console.log(`Restored ${rooms.size} room(s)`);
  } catch (err) {
    console.error('Failed to load rooms:', err.message);
  }
}

// ---------- room state ----------
function createRoom({ name, deck, customCards, settings }) {
  const id = roomCode();
  const room = {
    id,
    name: str(name, 60) || 'Planning session',
    deck: resolveDeck(deck, customCards),
    hostId: null,
    players: {},
    stories: [],
    currentStoryId: null,
    revealed: false,
    round: 1,
    timer: null,
    settings: {
      autoReveal: Boolean(settings?.autoReveal),
      anyoneCanControl: settings?.anyoneCanControl !== false,
      allowChangeAfterReveal: Boolean(settings?.allowChangeAfterReveal),
      timerSeconds: 60,
    },
    createdAt: Date.now(),
    lastActive: Date.now(),
  };
  rooms.set(id, room);
  scheduleSave();
  return room;
}

function viewFor(room, viewerId) {
  return {
    id: room.id,
    name: room.name,
    deck: room.deck,
    hostId: room.hostId,
    revealed: room.revealed,
    round: room.round,
    timer: room.timer,
    settings: room.settings,
    stories: room.stories,
    currentStoryId: room.currentStoryId,
    me: viewerId,
    serverNow: Date.now(),
    players: Object.values(room.players)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({
        id: p.id,
        name: p.name,
        avatar: p.avatar,
        role: p.role,
        connected: p.conns > 0,
        voted: p.vote !== null,
        vote: room.revealed || p.id === viewerId ? p.vote : null,
      })),
  };
}

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const c of clients.get(room.id) ?? []) send(c.res, 'state', viewFor(room, c.playerId));
  scheduleSave();
}

function emit(room, event, data, filter = () => true) {
  for (const c of clients.get(room.id) ?? []) if (filter(c.playerId)) send(c.res, event, data);
}

function clearRoomTimer(room) {
  clearTimeout(roomTimers.get(room.id));
  roomTimers.delete(room.id);
  room.timer = null;
}

function reveal(room) {
  room.revealed = true;
  clearRoomTimer(room);
}

function resetRound(room) {
  for (const p of Object.values(room.players)) p.vote = null;
  room.revealed = false;
  room.round += 1;
  clearRoomTimer(room);
}

function connectedVoters(room) {
  return Object.values(room.players).filter((p) => p.role === 'voter' && p.conns > 0);
}

function maybeAutoReveal(room) {
  if (!room.settings.autoReveal || room.revealed) return;
  const voters = connectedVoters(room);
  if (voters.length > 0 && voters.every((p) => p.vote !== null)) reveal(room);
}

function pickNewHost(room) {
  const candidates = Object.values(room.players)
    .filter((p) => p.conns > 0)
    .sort((a, b) => (a.role === 'voter' ? 0 : 1) - (b.role === 'voter' ? 0 : 1) || a.joinedAt - b.joinedAt);
  return candidates[0] ?? null;
}

function scheduleHostHandoff(room) {
  clearTimeout(hostHandoffTimers.get(room.id));
  hostHandoffTimers.set(
    room.id,
    setTimeout(() => {
      const host = room.players[room.hostId];
      if (host && host.conns > 0) return;
      const next = pickNewHost(room);
      if (next) {
        room.hostId = next.id;
        emit(room, 'toast', { text: `${next.name} is now the facilitator` });
        broadcast(room);
      }
    }, HOST_HANDOFF_MS),
  );
}

function currentStory(room) {
  return room.stories.find((s) => s.id === room.currentStoryId) ?? null;
}

function nextUnestimated(room, fromId) {
  const idx = room.stories.findIndex((s) => s.id === fromId);
  const ordered = [...room.stories.slice(idx + 1), ...room.stories.slice(0, Math.max(idx, 0))];
  return ordered.find((s) => s.estimate == null) ?? null;
}

// ---------- actions ----------
const HOST_ONLY = new Set(['updateSettings', 'setDeck', 'kick', 'makeHost', 'renameRoom']);
const CONTROL = new Set([
  'reveal', 'reset', 'timerStart', 'timerStop', 'selectStory', 'saveEstimate',
  'addStories', 'removeStory', 'editStory', 'moveStory', 'nudge', 'clearEstimate',
]);
const lastReaction = new Map();

function handleAction(room, player, body) {
  const isHost = room.hostId === player.id;
  const { type } = body;
  if (HOST_ONLY.has(type) && !isHost) throw httpError(403, 'Only the facilitator can do that');
  if (CONTROL.has(type) && !isHost && !room.settings.anyoneCanControl) throw httpError(403, 'Only the facilitator can do that');

  switch (type) {
    case 'vote': {
      if (player.role !== 'voter') throw httpError(400, 'Observers cannot vote');
      if (room.revealed && !room.settings.allowChangeAfterReveal) throw httpError(400, 'Votes are revealed — start a new round');
      const value = body.value == null ? null : String(body.value);
      if (value !== null && !room.deck.cards.includes(value)) throw httpError(400, 'Unknown card');
      player.vote = value;
      maybeAutoReveal(room);
      break;
    }
    case 'reveal':
      reveal(room);
      break;
    case 'reset':
      resetRound(room);
      break;
    case 'timerStart': {
      const seconds = Math.min(Math.max(Number(body.seconds) || room.settings.timerSeconds, 5), 3600);
      room.settings.timerSeconds = seconds;
      clearRoomTimer(room);
      room.timer = { endsAt: Date.now() + seconds * 1000, duration: seconds };
      roomTimers.set(
        room.id,
        setTimeout(() => {
          room.timer = null;
          if (!room.revealed) reveal(room);
          emit(room, 'toast', { text: '⏰ Time is up!' });
          broadcast(room);
        }, seconds * 1000),
      );
      break;
    }
    case 'timerStop':
      clearRoomTimer(room);
      break;
    case 'nudge': {
      const waiting = connectedVoters(room).filter((p) => p.vote === null).map((p) => p.id);
      emit(room, 'nudge', { from: player.name }, (id) => waiting.includes(id));
      return;
    }
    case 'addStories': {
      const titles = (Array.isArray(body.titles) ? body.titles : [body.titles])
        .map((t) => str(t, 200))
        .filter(Boolean)
        .slice(0, 100);
      for (const title of titles) {
        if (room.stories.length >= 300) break;
        room.stories.push({ id: uid(), title, estimate: null, history: [] });
      }
      if (!room.currentStoryId && room.stories.length) {
        room.currentStoryId = room.stories.find((s) => s.estimate == null)?.id ?? null;
      }
      break;
    }
    case 'editStory': {
      const s = room.stories.find((x) => x.id === body.id);
      const title = str(body.title, 200);
      if (s && title) s.title = title;
      break;
    }
    case 'removeStory':
      room.stories = room.stories.filter((s) => s.id !== body.id);
      if (room.currentStoryId === body.id) {
        room.currentStoryId = null;
        resetRound(room);
      }
      break;
    case 'moveStory': {
      const i = room.stories.findIndex((s) => s.id === body.id);
      const j = i + (body.dir === 'up' ? -1 : 1);
      if (i >= 0 && j >= 0 && j < room.stories.length) {
        [room.stories[i], room.stories[j]] = [room.stories[j], room.stories[i]];
      }
      break;
    }
    case 'selectStory':
      if (body.id !== null && !room.stories.some((s) => s.id === body.id)) throw httpError(404, 'Story not found');
      if (room.currentStoryId !== body.id) {
        room.currentStoryId = body.id;
        resetRound(room);
      }
      break;
    case 'clearEstimate': {
      const s = room.stories.find((x) => x.id === body.id);
      if (s) s.estimate = null;
      break;
    }
    case 'saveEstimate': {
      const value = str(body.value, 10);
      if (!value) throw httpError(400, 'Pick an estimate');
      let story = currentStory(room);
      if (!story) {
        story = { id: uid(), title: `Round ${room.round}`, estimate: null, history: [] };
        room.stories.push(story);
      }
      story.estimate = value;
      story.history.push({
        at: Date.now(),
        estimate: value,
        votes: Object.values(room.players)
          .filter((p) => p.vote !== null)
          .map((p) => ({ name: p.name, avatar: p.avatar, value: p.vote })),
      });
      const next = nextUnestimated(room, story.id);
      room.currentStoryId = next?.id ?? null;
      resetRound(room);
      emit(room, 'toast', { text: `Saved ${value} for “${story.title}”` });
      break;
    }
    case 'setRole':
      player.role = body.role === 'observer' ? 'observer' : 'voter';
      if (player.role === 'observer') player.vote = null;
      maybeAutoReveal(room);
      break;
    case 'profile': {
      const name = str(body.name, 30);
      if (name) player.name = name;
      if (AVATARS.includes(body.avatar)) player.avatar = body.avatar;
      break;
    }
    case 'react': {
      if (!REACTIONS.includes(body.emoji) || !room.players[body.to]) throw httpError(400, 'Bad reaction');
      const now = Date.now();
      if (now - (lastReaction.get(player.id) ?? 0) < 250) return;
      lastReaction.set(player.id, now);
      emit(room, 'reaction', { from: player.id, to: body.to, emoji: body.emoji });
      return;
    }
    case 'updateSettings': {
      const s = body.settings ?? {};
      for (const k of ['autoReveal', 'anyoneCanControl', 'allowChangeAfterReveal']) {
        if (k in s) room.settings[k] = Boolean(s[k]);
      }
      maybeAutoReveal(room);
      break;
    }
    case 'setDeck': {
      const deck = resolveDeck(body.deck, body.customCards);
      if (body.deck === 'custom' && deck.id !== 'custom') throw httpError(400, 'A custom deck needs at least 2 cards');
      room.deck = deck;
      resetRound(room);
      break;
    }
    case 'renameRoom': {
      const name = str(body.name, 60);
      if (name) room.name = name;
      break;
    }
    case 'kick': {
      const target = room.players[body.playerId];
      if (!target || target.id === player.id) throw httpError(400, 'Cannot remove that player');
      tokens.delete(target.token);
      delete room.players[target.id];
      for (const c of clients.get(room.id) ?? []) {
        if (c.playerId === target.id) {
          send(c.res, 'kicked', {});
          c.res.end();
        }
      }
      maybeAutoReveal(room);
      break;
    }
    case 'makeHost':
      if (!room.players[body.playerId]) throw httpError(404, 'Player not found');
      room.hostId = body.playerId;
      break;
    case 'claimHost': {
      const host = room.players[room.hostId];
      if (host && host.conns > 0) throw httpError(400, 'The facilitator is still here');
      room.hostId = player.id;
      break;
    }
    case 'leave':
      tokens.delete(player.token);
      delete room.players[player.id];
      if (room.hostId === player.id) room.hostId = pickNewHost(room)?.id ?? null;
      maybeAutoReveal(room);
      break;
    default:
      throw httpError(400, 'Unknown action');
  }
  broadcast(room);
}

// ---------- HTTP ----------
function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(httpError(413, 'Payload too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(httpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function authenticate(roomId, token) {
  const entry = tokens.get(token);
  const room = rooms.get(roomId);
  if (!room) throw httpError(404, 'Room not found');
  if (!entry || entry.roomId !== roomId || !room.players[entry.playerId]) throw httpError(401, 'Not a member of this room');
  return { room, player: room.players[entry.playerId] };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

async function serveStatic(req, res, pathname) {
  let file = pathname === '/' || pathname.startsWith('/r/') ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) return sendJSON(res, 403, { error: 'Forbidden' });
  try {
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJSON(res, 404, { error: 'Not found' });
  }
}

function openStream(req, res, roomId, token) {
  const { room, player } = authenticate(roomId, token);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 2000\n\n');
  const client = { res, playerId: player.id };
  if (!clients.has(room.id)) clients.set(room.id, new Set());
  clients.get(room.id).add(client);
  player.conns += 1;
  if (!room.hostId || !room.players[room.hostId]) room.hostId = player.id;
  if (room.hostId === player.id) clearTimeout(hostHandoffTimers.get(room.id));
  broadcast(room);

  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.get(room.id)?.delete(client);
    const p = room.players[player.id];
    if (!p) return;
    p.conns = Math.max(0, p.conns - 1);
    if (p.conns === 0) {
      if (room.hostId === p.id) scheduleHostHandoff(room);
      maybeAutoReveal(room);
    }
    broadcast(room);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (pathname === '/api/meta' && req.method === 'GET') {
      return sendJSON(res, 200, { decks: DECKS, reactions: REACTIONS, avatars: AVATARS });
    }
    if (pathname === '/api/rooms' && req.method === 'POST') {
      const room = createRoom(await readBody(req));
      return sendJSON(res, 201, { id: room.id });
    }
    const m = pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})(?:\/(join|events|action))?$/i);
    if (m) {
      const roomId = m[1].toUpperCase();
      const sub = m[2];
      if (!sub && req.method === 'GET') {
        const room = rooms.get(roomId);
        if (!room) throw httpError(404, 'Room not found');
        return sendJSON(res, 200, { id: room.id, name: room.name, players: Object.keys(room.players).length });
      }
      if (sub === 'join' && req.method === 'POST') {
        const room = rooms.get(roomId);
        if (!room) throw httpError(404, 'Room not found');
        const body = await readBody(req);
        if (body.resume) {
          // Rejoin with an existing token without touching the player's profile.
          const entry = tokens.get(body.token);
          if (!entry || entry.roomId !== roomId || !room.players[entry.playerId]) throw httpError(401, 'Session expired');
          return sendJSON(res, 200, { token: body.token, playerId: entry.playerId });
        }
        const name = str(body.name, 30) || 'Anonymous';
        const avatar = AVATARS.includes(body.avatar) ? body.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
        const role = body.role === 'observer' ? 'observer' : 'voter';
        const existing = tokens.get(body.token);
        if (existing && existing.roomId === roomId && room.players[existing.playerId]) {
          const p = room.players[existing.playerId];
          Object.assign(p, { name, avatar, role });
          broadcast(room);
          return sendJSON(res, 200, { token: p.token, playerId: p.id });
        }
        if (Object.keys(room.players).length >= 60) throw httpError(400, 'Room is full');
        const player = { id: uid(), token: uid() + uid(), name, avatar, role, vote: null, conns: 0, joinedAt: Date.now() };
        room.players[player.id] = player;
        tokens.set(player.token, { roomId, playerId: player.id });
        if (!room.hostId) room.hostId = player.id;
        broadcast(room);
        return sendJSON(res, 200, { token: player.token, playerId: player.id });
      }
      if (sub === 'events' && req.method === 'GET') {
        return openStream(req, res, roomId, url.searchParams.get('token'));
      }
      if (sub === 'action' && req.method === 'POST') {
        const body = await readBody(req);
        const { room, player } = authenticate(roomId, body.token);
        handleAction(room, player, body);
        return sendJSON(res, 200, { ok: true });
      }
    }
    if (pathname.startsWith('/api/')) throw httpError(404, 'Not found');
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    throw httpError(405, 'Method not allowed');
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) sendJSON(res, err.status ?? 500, { error: err.status ? err.message : 'Server error' });
  }
});

// Drop rooms nobody has touched in a week.
setInterval(() => {
  const cutoff = Date.now() - ROOM_TTL_MS;
  for (const room of rooms.values()) {
    if (room.lastActive < cutoff && !(clients.get(room.id)?.size)) {
      for (const p of Object.values(room.players)) tokens.delete(p.token);
      rooms.delete(room.id);
      scheduleSave();
    }
  }
}, 60 * 60 * 1000).unref();

loadRooms();
server.listen(PORT, () => console.log(`🃏 Planning Poker running at http://localhost:${PORT}`));
