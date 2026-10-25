// Room rules. Runs in whichever browser tab is currently the room's hub.

export const DECKS = {
  fibonacci: { name: 'Fibonacci', cards: ['0', '1', '2', '3', '5', '8', '13', '21', '34', '55', '?', '☕'] },
  modified: { name: 'Modified Fibonacci', cards: ['0', '½', '1', '2', '3', '5', '8', '13', '20', '40', '100', '?', '☕'] },
  tshirt: { name: 'T-Shirt sizes', cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?', '☕'] },
  powers: { name: 'Powers of 2', cards: ['0', '1', '2', '4', '8', '16', '32', '64', '?', '☕'] },
  hours: { name: 'Hours', cards: ['1', '2', '4', '8', '12', '16', '24', '32', '40', '?', '☕'] },
};
export const REACTIONS = ['👍', '🎉', '🤔', '😂', '🔥', '❤️', '👀', '🚀', '🍅', '✈️'];
export const AVATARS = ['🦊', '🐼', '🐨', '🦁', '🐯', '🐸', '🐙', '🦄', '🐝', '🦉', '🐧', '🐳', '🦖', '🐢', '🦩', '🐱'];

const MAX_PLAYERS = 60;
const MAX_STORIES = 300;
const MAX_HISTORY = 5;

const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const fail = (msg) => { throw new Error(msg); };

export function uid(bytes = 9) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function roomCode() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ROOM_ALPHABET[b % ROOM_ALPHABET.length]).join('');
}

function parseCustomDeck(input) {
  const cards = [...new Set(String(input ?? '').split(/[,\s]+/).map((c) => str(c, 5)).filter(Boolean))].slice(0, 20);
  return cards.length >= 2 ? cards : null;
}

export function resolveDeck(deckId, custom) {
  if (deckId === 'custom') {
    const cards = parseCustomDeck(custom);
    if (cards) return { id: 'custom', name: 'Custom', cards };
  }
  const d = DECKS[deckId] ?? DECKS.fibonacci;
  return { id: DECKS[deckId] ? deckId : 'fibonacci', name: d.name, cards: [...d.cards] };
}

export function createRoom({ id, name, deck, customCards, settings }) {
  return {
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
  };
}

// ---------- helpers ----------
export function reveal(room, ctx) {
  room.revealed = true;
  room.timer = null;
  ctx.clearTimer();
}

function resetRound(room, votes, ctx) {
  votes.clear();
  room.revealed = false;
  room.round += 1;
  room.timer = null;
  ctx.clearTimer();
}

const connectedVoters = (room, online) => Object.values(room.players).filter((p) => p.role === 'voter' && online.has(p.id));

export function maybeAutoReveal(room, votes, online, ctx) {
  if (!room.settings.autoReveal || room.revealed) return;
  const voters = connectedVoters(room, online);
  if (voters.length > 0 && voters.every((p) => votes.has(p.id))) reveal(room, ctx);
}

export function pickNewHost(room, online) {
  return Object.values(room.players)
    .filter((p) => online.has(p.id))
    .sort((a, b) => (a.role === 'voter' ? 0 : 1) - (b.role === 'voter' ? 0 : 1) || a.joinedAt - b.joinedAt)[0] ?? null;
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

/**
 * Apply one action to the room. Throws an Error with a user-facing message when rejected.
 * Returns false when nothing needs to be re-broadcast.
 * ctx: { online: Set<pid>, emit(type, data, toPids?), armTimer(), clearTimer(), canReact(pid) }
 */
export function applyAction(room, votes, pid, type, d = {}, ctx) {
  if (type === 'hello') return true;
  if (type === 'join') {
    const name = str(d.name, 30) || 'Anonymous';
    const avatar = AVATARS.includes(d.avatar) ? d.avatar : AVATARS[Math.floor(Math.random() * AVATARS.length)];
    const role = d.role === 'observer' ? 'observer' : 'voter';
    const existing = room.players[pid];
    if (existing) Object.assign(existing, { name, avatar, role });
    else {
      if (Object.keys(room.players).length >= MAX_PLAYERS) fail('Room is full');
      room.players[pid] = { id: pid, name, avatar, role, joinedAt: Date.now() };
    }
    if (!room.hostId || !room.players[room.hostId]) room.hostId = pid;
    return true;
  }

  const player = room.players[pid];
  if (!player) fail('You are not in this room');
  const isHost = room.hostId === pid;
  if (HOST_ONLY.has(type) && !isHost) fail('Only the facilitator can do that');
  if (CONTROL.has(type) && !isHost && !room.settings.anyoneCanControl) fail('Only the facilitator can do that');

  switch (type) {
    case 'vote': {
      if (player.role !== 'voter') fail('Observers cannot vote');
      if (room.revealed && !room.settings.allowChangeAfterReveal) fail('Votes are revealed — start a new round');
      const value = d.value == null ? null : String(d.value);
      if (value !== null && !room.deck.cards.includes(value)) fail('Unknown card');
      if (value === null) votes.delete(pid);
      else votes.set(pid, value);
      maybeAutoReveal(room, votes, ctx.online, ctx);
      break;
    }
    case 'reveal':
      reveal(room, ctx);
      break;
    case 'reset':
      resetRound(room, votes, ctx);
      break;
    case 'timerStart': {
      const seconds = Math.min(Math.max(Number(d.seconds) || room.settings.timerSeconds, 5), 3600);
      room.settings.timerSeconds = seconds;
      room.timer = { endsAt: Date.now() + seconds * 1000, duration: seconds };
      ctx.armTimer();
      break;
    }
    case 'timerStop':
      room.timer = null;
      ctx.clearTimer();
      break;
    case 'nudge': {
      const waiting = connectedVoters(room, ctx.online).filter((p) => !votes.has(p.id)).map((p) => p.id);
      ctx.emit('nudge', { from: player.name }, waiting);
      return false;
    }
    case 'addStories': {
      const titles = (Array.isArray(d.titles) ? d.titles : [d.titles]).map((t) => str(t, 200)).filter(Boolean).slice(0, 100);
      for (const title of titles) {
        if (room.stories.length >= MAX_STORIES) break;
        room.stories.push({ id: uid(), title, estimate: null, history: [] });
      }
      if (!room.currentStoryId && room.stories.length) {
        room.currentStoryId = room.stories.find((s) => s.estimate == null)?.id ?? null;
      }
      break;
    }
    case 'editStory': {
      const s = room.stories.find((x) => x.id === d.id);
      const title = str(d.title, 200);
      if (s && title) s.title = title;
      break;
    }
    case 'removeStory':
      room.stories = room.stories.filter((s) => s.id !== d.id);
      if (room.currentStoryId === d.id) {
        room.currentStoryId = null;
        resetRound(room, votes, ctx);
      }
      break;
    case 'moveStory': {
      const i = room.stories.findIndex((s) => s.id === d.id);
      const j = i + (d.dir === 'up' ? -1 : 1);
      if (i >= 0 && j >= 0 && j < room.stories.length) [room.stories[i], room.stories[j]] = [room.stories[j], room.stories[i]];
      break;
    }
    case 'selectStory':
      if (d.id !== null && !room.stories.some((s) => s.id === d.id)) fail('Story not found');
      if (room.currentStoryId !== d.id) {
        room.currentStoryId = d.id;
        resetRound(room, votes, ctx);
      }
      break;
    case 'clearEstimate': {
      const s = room.stories.find((x) => x.id === d.id);
      if (s) s.estimate = null;
      break;
    }
    case 'saveEstimate': {
      const value = str(d.value, 10);
      if (!value) fail('Pick an estimate');
      let story = room.stories.find((s) => s.id === room.currentStoryId);
      if (!story) {
        story = { id: uid(), title: `Round ${room.round}`, estimate: null, history: [] };
        room.stories.push(story);
      }
      story.estimate = value;
      story.history = [
        ...story.history,
        {
          at: Date.now(),
          estimate: value,
          votes: [...votes].filter(([id]) => room.players[id]).map(([id, v]) => ({ name: room.players[id].name, avatar: room.players[id].avatar, value: v })),
        },
      ].slice(-MAX_HISTORY);
      room.currentStoryId = nextUnestimated(room, story.id)?.id ?? null;
      resetRound(room, votes, ctx);
      ctx.emit('toast', { text: `Saved ${value} for “${story.title}”` });
      break;
    }
    case 'setRole':
      player.role = d.role === 'observer' ? 'observer' : 'voter';
      if (player.role === 'observer') votes.delete(pid);
      maybeAutoReveal(room, votes, ctx.online, ctx);
      break;
    case 'profile': {
      const name = str(d.name, 30);
      if (name) player.name = name;
      if (AVATARS.includes(d.avatar)) player.avatar = d.avatar;
      break;
    }
    case 'react':
      if (!REACTIONS.includes(d.emoji) || !room.players[d.to]) fail('Bad reaction');
      if (ctx.canReact(pid)) ctx.emit('reaction', { from: pid, to: d.to, emoji: d.emoji });
      return false;
    case 'updateSettings': {
      const s = d.settings ?? {};
      for (const k of ['autoReveal', 'anyoneCanControl', 'allowChangeAfterReveal']) if (k in s) room.settings[k] = Boolean(s[k]);
      maybeAutoReveal(room, votes, ctx.online, ctx);
      break;
    }
    case 'setDeck': {
      const deck = resolveDeck(d.deck, d.customCards);
      if (d.deck === 'custom' && deck.id !== 'custom') fail('A custom deck needs at least 2 cards');
      room.deck = deck;
      resetRound(room, votes, ctx);
      break;
    }
    case 'renameRoom': {
      const name = str(d.name, 60);
      if (name) room.name = name;
      break;
    }
    case 'kick': {
      const target = room.players[d.playerId];
      if (!target || target.id === pid) fail('Cannot remove that player');
      delete room.players[target.id];
      votes.delete(target.id);
      ctx.emit('kicked', {}, [target.id]);
      maybeAutoReveal(room, votes, ctx.online, ctx);
      break;
    }
    case 'makeHost':
      if (!room.players[d.playerId]) fail('Player not found');
      room.hostId = d.playerId;
      break;
    case 'claimHost':
      if (room.players[room.hostId] && ctx.online.has(room.hostId)) fail('The facilitator is still here');
      room.hostId = pid;
      break;
    case 'leave':
      delete room.players[pid];
      votes.delete(pid);
      if (room.hostId === pid) room.hostId = pickNewHost(room, ctx.online)?.id ?? null;
      maybeAutoReveal(room, votes, ctx.online, ctx);
      break;
    default:
      fail('Unknown action');
  }
  return true;
}
