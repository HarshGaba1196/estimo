// Estimo — planning poker client. No framework, no build step, no server.
import { DECKS, REACTIONS, AVATARS, createRoom, roomCode, uid } from './room.js';
import { openRoom } from './realtime.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const SPECIAL = ['?', '☕'];

const META = { decks: DECKS, reactions: REACTIONS, avatars: AVATARS };
let state = null;
let prevState = null;
let rt = null; // realtime room controller
let roomId = null;
let clockOffset = 0;
let selectedHandIndex = -1;
let resultsKey = '';

// ---------------- Actions ----------------
// Actions that never produce a new room state, so there's nothing to wait for.
const NO_REPLY = new Set(['react', 'nudge']);
let busyShowTimer = null;
let busySafetyTimer = null;

// Thin bar at the top of the page while we wait for the room to answer.
function setBusy(on) {
  clearTimeout(busyShowTimer);
  clearTimeout(busySafetyTimer);
  if (on) {
    busyShowTimer = setTimeout(() => { $('#progress-bar').hidden = false; }, 120);
    busySafetyTimer = setTimeout(() => setBusy(false), 6000);
  } else {
    $('#progress-bar').hidden = true;
  }
}

function action(type, payload = {}) {
  if (!rt) return;
  if (!NO_REPLY.has(type)) setBusy(true);
  rt.act(type, payload);
}

// ---------------- Toasts / helpers ----------------
function toast(text, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = text;
  $('#toasts').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 2600);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { window.prompt('Copy this link:', text); return false; }
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, ctx.currentTime);
    o.frequency.setValueAtTime(1320, ctx.currentTime + 0.09);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.3);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.32);
  } catch {}
}

function toggleTheme() {
  const root = document.documentElement;
  const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  root.dataset.theme = current === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
}

const me = () => state?.players.find((p) => p.id === state.me);
const isHost = () => state && state.hostId === state.me;
const canControl = () => state && (isHost() || state.settings.anyoneCanControl);
const roomUrl = (id) => `${location.origin}${location.pathname}?room=${id}${rt?.brokerIndex ? `&b=${rt.brokerIndex}` : ''}`;
const inviteUrl = () => roomUrl(state.id);
const pidKey = (id) => `estimo:room:${id}`;

// ---------------- Stats ----------------
function toNum(v) {
  if (v === '½') return 0.5;
  if (v == null || String(v).trim() === '') return NaN;
  return Number(v);
}
const isNum = (v) => Number.isFinite(toNum(v));
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function computeStats(st) {
  const cards = st.deck.cards;
  const numericDeck = cards.filter(isNum).length >= 2;
  const voters = st.players.filter((p) => p.vote != null);
  const counted = voters.filter((p) => (numericDeck ? isNum(p.vote) : !SPECIAL.includes(p.vote)));
  const groups = new Map();
  for (const p of voters) groups.set(p.vote, [...(groups.get(p.vote) ?? []), p]);
  const dist = cards.filter((c) => groups.has(c)).map((c) => ({ card: c, voters: groups.get(c) }));
  const base = { voters, counted, dist, numericDeck, maxGroup: Math.max(0, ...dist.map((d) => d.voters.length)) };
  if (!counted.length) return { ...base, empty: true };

  const valueOf = (v) => (numericDeck ? toNum(v) : cards.indexOf(v));
  const vals = counted.map((p) => valueOf(p.vote)).sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  const countedGroups = dist.filter((d) => counted.includes(d.voters[0]));
  const topCount = Math.max(...countedGroups.map((d) => d.voters.length));
  const mode = countedGroups.filter((d) => d.voters.length === topCount).map((d) => d.card);
  const idxs = counted.map((p) => cards.indexOf(p.vote));
  const minIdx = Math.min(...idxs);
  const maxIdx = Math.max(...idxs);
  const spread = maxIdx - minIdx;

  let suggested;
  if (numericDeck) {
    const numericCards = cards.filter(isNum);
    suggested = numericCards.reduce((best, c) => {
      const d = Math.abs(toNum(c) - avg);
      const bd = Math.abs(toNum(best) - avg);
      return d < bd || (d === bd && toNum(c) > toNum(best)) ? c : best;
    }, numericCards[0]);
  } else {
    suggested = cards[Math.ceil(median)];
  }
  const outliers = spread >= 2 ? counted.filter((p) => [minIdx, maxIdx].includes(cards.indexOf(p.vote))) : [];
  return {
    ...base,
    avg, median, mode, spread, suggested, outliers,
    lowest: counted.filter((p) => cards.indexOf(p.vote) === minIdx),
    highest: counted.filter((p) => cards.indexOf(p.vote) === maxIdx),
    agreement: topCount / counted.length,
    consensus: counted.length >= 2 && spread === 0,
  };
}

// ---------------- Landing ----------------
function buildDeckOptions(container, selected = 'fibonacci', customCards = '') {
  const form = container.closest('form');
  const custom = $('.custom-cards', form);
  const decks = { ...META.decks, custom: { name: 'Custom', cards: ['your', 'own', 'cards'] } };
  container.innerHTML = Object.entries(decks)
    .map(([id, d]) => `
      <label class="deck-option">
        <input type="radio" name="deck" value="${id}" ${id === selected ? 'checked' : ''} />
        <span><b>${esc(d.name)}</b><small>${esc(d.cards.join(' '))}</small></span>
      </label>`)
    .join('');
  custom.value = customCards;
  const sync = () => { custom.hidden = form.elements.deck.value !== 'custom'; };
  container.onchange = sync;
  sync();
}

function showLanding() {
  $('#room').hidden = true;
  $('#landing').hidden = false;
  document.title = 'Estimo — Planning Poker';
  const form = $('#create-form');
  buildDeckOptions($('#deck-options'));
  const profile = LS.get('estimo:profile', {});
  if (profile.name) form.elements.name.value = profile.name;
}

$('#create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = $('button[type=submit]', f);
  btn.disabled = true;
  try {
    const id = roomCode();
    const room = createRoom({
      id,
      name: f.elements.roomName.value,
      deck: f.elements.deck.value,
      customCards: f.elements.customCards.value,
      settings: { autoReveal: f.elements.autoReveal.checked },
    });
    const profile = { ...LS.get('estimo:profile', {}), name: f.elements.name.value.trim() };
    LS.set('estimo:profile', profile);
    history.pushState({}, '', `?room=${id}`);
    await enterRoom(id, { create: room, profile: { ...profile, role: 'voter' } });
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#join-code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const code = e.currentTarget.elements.code.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return toast('Room codes are 6 characters', 'error');
  history.pushState({}, '', `?room=${code}`);
  enterRoom(code);
});

// ---------------- Joining ----------------
function buildAvatarGrid(form, selected) {
  const grid = $('[data-avatar-grid]', form);
  form.dataset.avatar = selected || META.avatars[Math.floor(Math.random() * META.avatars.length)];
  grid.innerHTML = META.avatars
    .map((a) => `<button type="button" data-av="${a}" aria-pressed="${a === form.dataset.avatar}" aria-label="Avatar ${a}">${a}</button>`)
    .join('');
  grid.onclick = (e) => {
    const b = e.target.closest('[data-av]');
    if (!b) return;
    form.dataset.avatar = b.dataset.av;
    $$('[data-av]', grid).forEach((x) => x.setAttribute('aria-pressed', x === b));
  };
}

function askToJoin(view) {
  return new Promise((resolve) => {
    const dlg = $('#join-dialog');
    const form = $('#join-form');
    const profile = LS.get('estimo:profile', {});
    const count = view?.players.length ?? 0;
    $('#join-room-name').textContent = view?.name ?? 'room';
    $('#join-room-meta').textContent = count ? `${count} ${count === 1 ? 'person is' : 'people are'} here` : 'Be the first one in';
    form.elements.name.value = profile.name || '';
    form.elements.role.value = profile.role || 'voter';
    buildAvatarGrid(form, profile.avatar);
    dlg.oncancel = (e) => e.preventDefault();
    form.onsubmit = (e) => {
      e.preventDefault();
      const p = { name: form.elements.name.value.trim(), avatar: form.dataset.avatar, role: form.elements.role.value };
      LS.set('estimo:profile', p);
      dlg.close();
      resolve(p);
    };
    dlg.showModal();
  });
}

const NET_ERRORS = {
  notfound: "Couldn't find that room. Check the code, or ask for a fresh invite link.",
  broker: "Couldn't reach the connection servers. Check your internet and try again.",
  lib: "Couldn't load the connection library. Check your internet and reload.",
  crypto: 'This browser cannot encrypt messages. Open the page over HTTPS.',
  taken: 'Room code clash. Please try again.',
};

const LOAD_STEPS = {
  connecting: ['Connecting…', 20],
  retrying: ['Trying a backup server…', 35],
  creating: ['Setting up your room…', 70],
  searching: ['Looking for the room…', 55],
  syncing: ['Syncing with your team…', 85],
};

function showLoading(step) {
  const [text, pct] = LOAD_STEPS[step] ?? [step, 10];
  $('#loading-text').textContent = text;
  $('#load-fill').style.width = `${pct}%`;
  $('#loading').hidden = false;
  $('#progress-bar').hidden = false;
}

function hideLoading() {
  $('#load-fill').style.width = '100%';
  $('#loading').hidden = true;
  $('#progress-bar').hidden = true;
}

async function enterRoom(id, { create = null, profile = null } = {}) {
  id = id.toUpperCase();
  rt?.close();
  rt = null;
  state = null;
  prevState = null;
  rawView = null;
  offlineSince.clear();
  roomId = id;
  $('#landing').hidden = true;
  $('#room').hidden = false;
  $('#room').classList.remove('ready');
  showLoading('connecting');
  const broker = Number(new URLSearchParams(location.search).get('b')) || 0;
  try {
    rt = await openRoom({ code: id, create, broker, onState, onEvent, onStatus, onProgress: showLoading });
  } catch (err) {
    hideLoading();
    toast(NET_ERRORS[err.type] ?? err.message, 'error');
    history.replaceState({}, '', location.pathname);
    return showLanding();
  }
  hideLoading();
  history.replaceState({}, '', roomUrl(id).slice(location.origin.length));

  const view = rt.view();
  const stored = LS.get(pidKey(id), null);
  if (stored?.pid && view?.players.some((p) => p.id === stored.pid)) {
    rt.setPid(stored.pid);
    return;
  }
  const p = profile ?? (await askToJoin(view));
  const pid = stored?.pid ?? uid();
  LS.set(pidKey(id), { pid });
  rt.setPid(pid);
  action('join', p);
}

// People who leave disappear from the table. They're only hidden (not removed from the room), so
// they get their seat back when they return, and a short grace period keeps a page refresh from
// making their card blink out and back.
const OFFLINE_GRACE_MS = 8000;
const offlineSince = new Map();
let rawView = null;
let visibilityTimer = null;

function withVisiblePlayers(view) {
  const now = Date.now();
  const wasConnected = new Set((state?.allPlayers ?? []).filter((p) => p.connected).map((p) => p.id));
  let nextExpiry = Infinity;
  for (const p of view.players) {
    if (p.connected) offlineSince.delete(p.id);
    else if (!offlineSince.has(p.id)) offlineSince.set(p.id, wasConnected.has(p.id) ? now : 0);
  }
  const players = view.players.filter((p) => {
    if (p.connected || p.id === view.me) return true;
    const expires = offlineSince.get(p.id) + OFFLINE_GRACE_MS;
    if (expires > now) nextExpiry = Math.min(nextExpiry, expires);
    return expires > now;
  });
  clearTimeout(visibilityTimer);
  if (nextExpiry < Infinity) {
    visibilityTimer = setTimeout(() => {
      if (!rawView) return;
      prevState = state;
      state = withVisiblePlayers(rawView);
      render();
    }, nextExpiry - now + 50);
  }
  return { ...view, allPlayers: view.players, players };
}

function onState(view) {
  $('#conn-banner').hidden = true;
  setBusy(false);
  rawView = view;
  prevState = state;
  state = withVisiblePlayers(view);
  clockOffset = state.serverNow - Date.now();
  render();
}

function onEvent(type, data) {
  switch (type) {
    case 'toast': return toast(data.text);
    case 'error':
      setBusy(false);
      return toast(data.text, 'error');
    case 'reaction': return flyReaction(data);
    case 'nudge': {
      toast(`👋 ${data.from} is waiting for your vote`);
      beep();
      const hand = $('#hand');
      hand.classList.remove('shake');
      void hand.offsetWidth;
      hand.classList.add('shake');
      return;
    }
    case 'kicked':
      LS.del(pidKey(roomId));
      toast('You were removed from the room', 'error');
      return leaveToLanding();
  }
}

function onStatus(connected) {
  $('#conn-banner').hidden = connected;
}

function leaveToLanding() {
  $('#room').classList.remove('ready');
  rt?.close();
  rt = null;
  state = null;
  history.pushState({}, '', location.pathname);
  showLanding();
}

// ---------------- Rendering ----------------
function render() {
  if (!state) return;
  $('#room').classList.add('ready');
  renderHeader();
  renderStories();
  renderSeats();
  renderTableCenter();
  renderResults();
  renderHand();
  maybeCelebrate();
  const voters = state.players.filter((p) => p.role === 'voter');
  const voted = voters.filter((p) => p.voted).length;
  document.title = `${state.revealed ? '✓' : `(${voted}/${voters.length})`} ${state.name} — Estimo`;
}

function renderHeader() {
  $('#room-name').textContent = state.name;
  $('#room-code').textContent = state.id;
  $('#settings-btn').hidden = !isHost();
  const m = me();
  $('#me-btn').innerHTML = m ? `<span class="av">${m.avatar}</span><span class="nm">${esc(m.name)}</span>${isHost() ? '<span class="role-tag">Facilitator</span>' : ''}${m.role === 'observer' ? '<span class="role-tag observer">Observer</span>' : ''}` : '';
  tickTimer();
}

function tickTimer() {
  const el = $('#timer');
  if (!state?.timer) { el.hidden = true; return; }
  const left = Math.max(0, state.timer.endsAt - (Date.now() + clockOffset));
  const s = Math.ceil(left / 1000);
  el.hidden = false;
  el.textContent = `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  el.classList.toggle('low', s <= 10);
}
setInterval(tickTimer, 250);

function storyHistoryText(s) {
  const last = s.history?.at(-1);
  if (!last) return s.title;
  return `${s.title}\n\nLast round: ${last.votes.map((v) => `${v.name}: ${v.value}`).join(', ') || 'no votes'}`;
}

function renderStories() {
  const list = $('#story-list');
  const ctl = canControl();
  $('#story-form').hidden = !ctl;
  if (list.querySelector('.story-edit')) return; // don't clobber an in-progress edit
  if (!state.stories.length) {
    list.innerHTML = `<li class="story-empty">${ctl ? 'No stories yet. Paste your backlog above — one per line — or just start voting.' : 'No stories yet.'}</li>`;
  } else {
    list.innerHTML = state.stories
      .map((s, i) => `
        <li class="story ${s.id === state.currentStoryId ? 'current' : ''} ${s.estimate != null ? 'done' : ''}" data-id="${s.id}" title="${esc(storyHistoryText(s))}" tabindex="0">
          <span class="story-title">${esc(s.title)}</span>
          <span class="story-est">${s.estimate != null ? esc(s.estimate) : '–'}</span>
          ${ctl ? `<span class="story-menu">
            <button data-story-act="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button data-story-act="down" title="Move down" ${i === state.stories.length - 1 ? 'disabled' : ''}>↓</button>
            <button data-story-act="edit" title="Rename">✎</button>
            ${s.estimate != null ? '<button data-story-act="clear" title="Clear estimate">↺</button>' : ''}
            <button data-story-act="remove" title="Delete">✕</button>
          </span>` : ''}
        </li>`)
      .join('');
  }
  const done = state.stories.filter((s) => s.estimate != null);
  $('#story-count').textContent = state.stories.length ? `(${state.stories.length})` : '';
  $('#stat-done').textContent = `${done.length}/${state.stories.length}`;
  $('#stat-total').textContent = fmt(done.reduce((sum, s) => sum + (isNum(s.estimate) ? toNum(s.estimate) : 0), 0));

  const cur = state.stories.find((s) => s.id === state.currentStoryId);
  $('#story-eyebrow').textContent = cur ? `Story ${state.stories.indexOf(cur) + 1} of ${state.stories.length}` : `Round ${state.round}`;
  $('#current-story-title').textContent = cur ? cur.title : 'Quick estimate';
}

function seatOrder() {
  const ps = [...state.players];
  const i = ps.findIndex((p) => p.id === state.me);
  return i > 0 ? [...ps.slice(i), ...ps.slice(0, i)] : ps;
}

function renderSeats() {
  const seats = $('#seats');
  const players = seatOrder();
  seats.classList.toggle('compact', players.length > 12);
  const stats = state.revealed ? computeStats(state) : null;
  const outlierIds = new Set(stats?.outliers?.map((p) => p.id) ?? []);

  const existing = new Map($$('.seat', seats).map((el) => [el.dataset.id, el]));
  const prevPlayers = new Map((prevState?.players ?? []).map((p) => [p.id, p]));
  players.forEach((p, i) => {
    let el = existing.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'seat';
      el.dataset.id = p.id;
      el.innerHTML = `
        <div class="seat-card"><div class="flip"><div class="back"></div><div class="face"></div></div></div>
        <button class="seat-name" type="button"><span class="av"></span><span class="nm"></span></button>
        <span class="role-tags"><span class="role-tag host-tag" hidden>Facilitator</span><span class="role-tag observer" hidden>Observer</span></span>`;
    }
    existing.delete(p.id);
    seats.append(el); // keeps DOM order in sync with seat order
    const wasVoted = prevPlayers.get(p.id)?.voted;
    el.classList.toggle('voted', p.voted);
    el.classList.toggle('revealed', state.revealed);
    el.classList.toggle('me', p.id === state.me);
    el.classList.toggle('offline', !p.connected);
    el.classList.toggle('observer', p.role === 'observer');
    el.classList.toggle('outlier', outlierIds.has(p.id));
    el.classList.toggle('thinking', p.connected && p.role === 'voter');
    if (p.voted && wasVoted === false && !state.revealed) {
      el.classList.add('just-voted');
      setTimeout(() => el.classList.remove('just-voted'), 500);
    }
    $('.flip', el).style.transitionDelay = state.revealed && !prevState?.revealed ? `${i * 70}ms` : '0ms';
    $('.face', el).textContent = p.vote ?? '';
    $('.av', el).textContent = p.avatar;
    $('.nm', el).textContent = p.name;
    $('.host-tag', el).hidden = p.id !== state.hostId;
    $('.role-tag.observer', el).hidden = p.role !== 'observer';
    el.classList.toggle('host', p.id === state.hostId);
    $('.seat-name', el).title = `${p.name}${p.id === state.hostId ? ' (facilitator)' : ''}${p.role === 'observer' ? ' · observer' : ''}${p.connected ? '' : ' · offline'}`;
  });
  existing.forEach((el) => el.remove());
}

function renderTableCenter() {
  const status = $('#table-status');
  const actions = $('#table-actions');
  const voters = state.players.filter((p) => p.role === 'voter' && p.connected);
  const voted = state.players.filter((p) => p.voted).length;
  const ctl = canControl();
  const host = state.allPlayers.find((p) => p.id === state.hostId);
  const hostAway = host && !host.connected && !isHost();
  const takeOver = hostAway ? '<button class="btn btn-sm sub" data-action="claim-host">Facilitator is away — take over</button>' : '';

  if (state.revealed) {
    const s = computeStats(state);
    let headline;
    if (s.empty) headline = '<span class="big">—</span>Nobody picked a card';
    else if (s.consensus) headline = `<span class="big">🎉 ${esc(s.counted[0].vote)}</span>Everyone agrees!`;
    else if (s.numericDeck) headline = `<span class="big">${fmt(s.avg)}</span>average · suggested ${esc(s.suggested)}`;
    else headline = `<span class="big">${esc(s.suggested)}</span>median estimate`;
    status.innerHTML = headline;
    actions.innerHTML = ctl
      ? `<button class="btn" data-action="reset">↻ Re-vote</button>${takeOver}`
      : `<span>Waiting for the facilitator</span>${takeOver}`;
    return;
  }

  if (state.players.length <= 1) {
    status.innerHTML = '<span class="big">👋</span>Invite your team: share the link to get everyone in';
    actions.innerHTML = `<button class="btn" data-action="copy-link">⧉ Copy invite link</button>${ctl && voted ? '<button class="btn sub" data-action="reveal">Reveal</button>' : ''}`;
    return;
  }

  const total = Math.max(voters.length, voted);
  const pct = total ? Math.round((voted / total) * 100) : 0;
  status.innerHTML = `<span class="big">${voted} / ${total}</span>${voted === total && total ? 'Everyone has voted!' : 'votes in'}
    <div class="progress"><i style="width:${pct}%"></i></div>`;
  if (!ctl) {
    actions.innerHTML = `<span>Waiting for the facilitator to reveal</span>${takeOver}`;
    return;
  }
  const waiting = voters.some((p) => !p.voted);
  actions.innerHTML = `
    <button class="btn" data-action="reveal" ${voted ? '' : 'disabled'}>Reveal cards</button>
    ${state.timer
      ? '<button class="btn sub" data-action="timer-stop">Stop timer</button>'
      : '<button class="btn sub" data-action="timer-menu">⏱ Timer</button>'}
    ${waiting && voted ? '<button class="btn sub" data-action="nudge" title="Ping everyone who has not voted">👋 Nudge</button>' : ''}
    ${takeOver}`;
}

function renderResults() {
  const el = $('#results');
  if (!state.revealed) {
    const voters = state.players.filter((p) => p.role === 'voter' && p.connected);
    const voted = state.players.filter((p) => p.voted).length;
    const key = `wait:${state.round}:${voted}/${voters.length}`;
    if (key === resultsKey) return;
    resultsKey = key;
    el.classList.add('idle');
    el.classList.remove('live');
    el.innerHTML = `
      <div class="results-head"><h3>Results</h3><span class="spacer"></span><span class="muted">Round ${state.round}</span></div>
      <div class="results-wait">
        <span class="icon">🂠</span>
        <b>Cards are face down</b>
        <span>${voted} of ${Math.max(voters.length, voted)} voted. Results show up here the moment cards are revealed.</span>
      </div>`;
    return;
  }
  const key = JSON.stringify([state.round, state.players.map((p) => [p.id, p.vote, p.name, p.avatar]), canControl(), state.deck.cards]);
  if (key === resultsKey) return;
  resultsKey = key;
  const s = computeStats(state);
  el.classList.remove('idle');
  el.classList.add('live');

  const verdict = s.empty ? '' : s.consensus
    ? '<span class="verdict good">Consensus</span>'
    : s.agreement >= 0.66 || s.spread <= 1
      ? '<span class="verdict ok">Close agreement</span>'
      : '<span class="verdict bad">Wide spread — worth a chat</span>';

  const tiles = s.empty ? '' : `
    <div class="stats">
      ${s.numericDeck ? `<div class="stat"><div class="lbl">Average</div><div class="val">${fmt(s.avg)}</div></div>` : ''}
      <div class="stat"><div class="lbl">Median</div><div class="val">${s.numericDeck ? fmt(s.median) : esc(s.suggested)}</div></div>
      <div class="stat"><div class="lbl">Agreement</div><div class="val">${Math.round(s.agreement * 100)}%</div><div class="sub">${s.counted.length} counted vote${s.counted.length === 1 ? '' : 's'}</div></div>
      <div class="stat hl"><div class="lbl">Suggested</div><div class="val">${esc(s.suggested)}</div><div class="sub">${s.numericDeck ? 'nearest card to average' : 'median card'}</div></div>
    </div>`;

  const dist = s.dist.length ? `
    <div class="dist">
      ${s.dist.map((d) => `
        <div class="dist-row ${d.voters.length === s.maxGroup && !SPECIAL.includes(d.card) ? 'top' : ''}">
          <div class="dist-card">${esc(d.card)}</div>
          <div class="dist-bar"><i style="width:${(d.voters.length / s.voters.length) * 100}%"></i></div>
          <div class="dist-voters" title="${esc(d.voters.map((p) => p.name).join(', '))}">${d.voters.slice(0, 4).map((p) => `<span>${p.avatar}</span>`).join('')}${d.voters.length > 4 ? `<span class="more">+${d.voters.length - 4}</span>` : ''}</div>
        </div>`).join('')}
    </div>` : '<p class="muted">No one voted this round.</p>';

  const names = (arr) => arr.map((p) => `${p.avatar} ${esc(p.name)}`).join(', ');
  const insight = s.outliers?.length
    ? `<div class="insight">💬 Biggest gap: <b>${names(s.lowest)}</b> said <b>${esc(s.lowest[0].vote)}</b>, <b>${names(s.highest)}</b> said <b>${esc(s.highest[0].vote)}</b>. Hear them out, then re-vote.</div>`
    : '';
  const special = s.voters.filter((p) => SPECIAL.includes(p.vote));
  const specialNote = special.length
    ? `<div class="insight" style="border-left-color:var(--accent)">${special.some((p) => p.vote === '☕') ? '☕ Someone needs a break. ' : ''}${special.some((p) => p.vote === '?') ? '❓ Some people are unsure — the story may need clarifying.' : ''}</div>`
    : '';

  const saveCards = state.deck.cards.filter((c) => !SPECIAL.includes(c));
  const save = canControl() ? `
    <div class="save-row">
      <span class="lbl">Save estimate <span class="muted">(moves to the next story)</span></span>
      ${saveCards.map((c) => `<button class="save-chip ${c === s.suggested ? 'suggested' : ''}" data-save="${esc(c)}" title="Save ${esc(c)} and move to the next story">${esc(c)}</button>`).join('')}
    </div>` : '';

  el.innerHTML = `
    <div class="results-head"><h3>Results</h3>${verdict}<span class="spacer"></span><span class="muted">Round ${state.round}</span></div>
    ${tiles}${save}${dist}${insight}${specialNote}`;
}

function renderHand() {
  const hand = $('#hand');
  const m = me();
  const hint = $('#hand-hint');
  if (!m) return;
  if (m.role === 'observer') {
    hand.innerHTML = '<div class="hand-observer">You are observing. <button class="btn btn-sm" data-action="become-voter">Join as voter</button></div>';
    hint.textContent = '';
    return;
  }
  const locked = state.revealed && !state.settings.allowChangeAfterReveal;
  const cards = state.deck.cards;
  const sig = JSON.stringify([cards, m.vote, locked]);
  if (hand.dataset.sig !== sig) {
    hand.dataset.sig = sig;
    hand.innerHTML = cards
      .map((c, i) => `<button class="pcard-btn" role="radio" aria-checked="${m.vote === c}" data-card="${esc(c)}" data-v="${esc(c)}" ${locked ? 'disabled' : ''}>
          ${esc(c)}${i < 10 ? `<span class="key">${(i + 1) % 10}</span>` : ''}
        </button>`)
      .join('');
  }
  selectedHandIndex = cards.indexOf(m.vote);
  hint.innerHTML = locked
    ? 'Cards are revealed — waiting for the next round'
    : m.vote != null
      ? `You picked <b>${esc(m.vote)}</b> · <kbd>Esc</kbd> to withdraw`
      : 'Pick a card · use number keys <kbd>1</kbd>–<kbd>9</kbd> · <kbd>?</kbd> for shortcuts';
}

function vote(value) {
  const m = me();
  if (!m || m.role !== 'voter') return;
  if (state.revealed && !state.settings.allowChangeAfterReveal) return;
  const next = m.vote === value ? null : value;
  // Optimistic update so the card lifts instantly.
  m.vote = next;
  m.voted = next != null;
  renderHand();
  action('vote', { value: next });
}

// ---------------- Celebration ----------------
function maybeCelebrate() {
  if (!state.revealed || prevState?.revealed !== false || prevState.round !== state.round) return;
  const s = computeStats(state);
  if (s.consensus) setTimeout(confetti, 450);
}

function confetti() {
  const canvas = $('#confetti');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const colors = ['#6d4cff', '#19b8d6', '#f79009', '#12b76a', '#f04438', '#ffd166'];
  const parts = Array.from({ length: 160 }, () => ({
    x: innerWidth / 2 + (Math.random() - 0.5) * 200,
    y: innerHeight / 2.4,
    vx: (Math.random() - 0.5) * 16,
    vy: -Math.random() * 15 - 4,
    r: Math.random() * 6 + 4,
    rot: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    c: colors[Math.floor(Math.random() * colors.length)],
  }));
  const start = performance.now();
  (function frame(t) {
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (const p of parts) {
      p.vy += 0.42; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2);
      ctx.restore();
    }
    if (t - start < 3200) requestAnimationFrame(frame);
    else ctx.clearRect(0, 0, innerWidth, innerHeight);
  })(start);
}

// ---------------- Reactions ----------------
function seatCenter(playerId) {
  const el = $(`.seat[data-id="${CSS.escape(playerId)}"] .seat-name`);
  if (!el) return { x: innerWidth / 2, y: innerHeight / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function flyReaction({ from, to, emoji }) {
  const a = seatCenter(from);
  const b = seatCenter(to);
  const el = document.createElement('div');
  el.className = 'flying-emoji';
  el.textContent = emoji;
  el.style.left = `${a.x - 18}px`;
  el.style.top = `${a.y - 18}px`;
  document.body.append(el);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lift = -Math.min(160, 60 + Math.hypot(dx, dy) * 0.3);
  el.animate(
    [
      { transform: 'translate(0,0) scale(.6) rotate(0deg)' },
      { transform: `translate(${dx / 2}px, ${dy / 2 + lift}px) scale(1.3) rotate(180deg)`, offset: 0.5 },
      { transform: `translate(${dx}px, ${dy}px) scale(1) rotate(360deg)` },
    ],
    { duration: 800, easing: 'cubic-bezier(.4,.1,.4,1)' },
  ).onfinish = () => {
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1 }, { transform: `translate(${dx}px, ${dy - 30}px) scale(2.2)`, opacity: 0 }], {
      duration: 500,
      easing: 'ease-out',
    }).onfinish = () => el.remove();
    const seat = $(`.seat[data-id="${CSS.escape(to)}"]`);
    seat?.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(-8deg)' }, { transform: 'rotate(8deg)' }, { transform: 'rotate(0)' }], { duration: 350 });
  };
}

// ---------------- Popovers ----------------
function openPopover(anchor, html, onClick) {
  const pop = $('#popover');
  pop.innerHTML = html;
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), innerWidth - pw - 8);
  let top = r.top - ph - 8;
  if (top < 8) top = r.bottom + 8;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    onClick(b);
    closePopover();
  };
}
function closePopover() { $('#popover').hidden = true; }
document.addEventListener('pointerdown', (e) => {
  if (!$('#popover').hidden && !e.target.closest('#popover') && !e.target.closest('[data-action="timer-menu"]') && !e.target.closest('.seat-name')) closePopover();
});

function openSeatMenu(seatEl) {
  const id = seatEl.dataset.id;
  if (id === state.me) return openProfile();
  const p = state.players.find((x) => x.id === id);
  if (!p) return;
  const hostMenu = isHost()
    ? `<div class="menu">
        <button data-op="host">Make facilitator</button>
        <button data-op="kick" class="danger">Remove from room</button>
      </div>`
    : '';
  openPopover(
    $('.seat-name', seatEl),
    `<h4>${p.avatar} ${esc(p.name)}</h4><div class="emoji-row">${META.reactions.map((r) => `<button data-emoji="${r}">${r}</button>`).join('')}</div>${hostMenu}`,
    (b) => {
      if (b.dataset.emoji) action('react', { to: id, emoji: b.dataset.emoji });
      else if (b.dataset.op === 'host') action('makeHost', { playerId: id });
      else if (b.dataset.op === 'kick' && confirm(`Remove ${p.name} from the room?`)) action('kick', { playerId: id });
    },
  );
}

function openTimerMenu(anchor) {
  const opts = [[30, '30 s'], [60, '1 min'], [120, '2 min'], [180, '3 min'], [300, '5 min']];
  openPopover(
    anchor,
    `<h4>⏱ Countdown — auto-reveals at zero</h4><div class="menu">${opts.map(([s, l]) => `<button data-sec="${s}">${l}</button>`).join('')}</div>`,
    (b) => action('timerStart', { seconds: Number(b.dataset.sec) }),
  );
}

// ---------------- Dialogs ----------------
function openProfile() {
  const m = me();
  const dlg = $('#profile-dialog');
  const form = $('#profile-form');
  form.elements.name.value = m.name;
  form.elements.role.value = m.role;
  buildAvatarGrid(form, m.avatar);
  dlg.showModal();
}
$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (e.submitter?.value === 'save') {
    const m = me();
    const p = { name: form.elements.name.value.trim(), avatar: form.dataset.avatar, role: form.elements.role.value };
    LS.set('estimo:profile', p);
    await action('profile', { name: p.name, avatar: p.avatar });
    if (p.role !== m.role) await action('setRole', { role: p.role });
  }
  $('#profile-dialog').close();
});

function openSettings() {
  const form = $('#settings-form');
  form.elements.roomName.value = state.name;
  buildDeckOptions($('#settings-deck-options'), state.deck.id, state.deck.id === 'custom' ? state.deck.cards.join(', ') : '');
  for (const k of ['autoReveal', 'anyoneCanControl', 'allowChangeAfterReveal']) form.elements[k].checked = state.settings[k];
  $('#settings-dialog').showModal();
}
$('#settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (e.submitter?.value === 'save') {
    const f = form.elements;
    if (f.roomName.value.trim() && f.roomName.value.trim() !== state.name) await action('renameRoom', { name: f.roomName.value });
    const deck = f.deck.value;
    const custom = f.customCards.value;
    if (deck !== state.deck.id || (deck === 'custom' && custom !== state.deck.cards.join(', '))) await action('setDeck', { deck, customCards: custom });
    await action('updateSettings', {
      settings: { autoReveal: f.autoReveal.checked, anyoneCanControl: f.anyoneCanControl.checked, allowChangeAfterReveal: f.allowChangeAfterReveal.checked },
    });
  }
  $('#settings-dialog').close();
});

// ---------------- Stories ----------------
$('#story-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const ta = e.currentTarget.elements.titles;
  const titles = ta.value.split('\n').map((t) => t.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  if (!titles.length) return;
  action('addStories', { titles });
  ta.value = '';
});
$('#story-form textarea').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    e.currentTarget.form.requestSubmit();
  }
});

$('#story-list').addEventListener('click', (e) => {
  const li = e.target.closest('.story');
  if (!li || !canControl() || e.target.closest('.story-edit')) return;
  const id = li.dataset.id;
  const act = e.target.closest('[data-story-act]')?.dataset.storyAct;
  const story = state.stories.find((s) => s.id === id);
  if (act === 'up' || act === 'down') return action('moveStory', { id, dir: act });
  if (act === 'remove') return confirm(`Delete “${story.title}”?`) && action('removeStory', { id });
  if (act === 'clear') return action('clearEstimate', { id });
  if (act === 'edit') {
    const titleEl = $('.story-title', li);
    titleEl.innerHTML = `<input class="story-edit" value="${esc(story.title)}" maxlength="200" />`;
    const input = $('input', titleEl);
    input.focus();
    input.select();
    const finish = (save) => {
      const v = input.value.trim();
      input.remove();
      if (save && v && v !== story.title) action('editStory', { id, title: v });
      renderStories();
    };
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
      ev.stopPropagation();
    };
    input.onblur = () => finish(true);
    return;
  }
  if (id !== state.currentStoryId) {
    action('selectStory', { id });
    if (innerWidth <= 1100) $('#sidebar').classList.remove('open');
  }
});
$('#story-list').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('story')) e.target.click();
});

function exportCsv() {
  if (!state.stories.length) return toast('No stories to export yet');
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['#', 'Story', 'Estimate', 'Rounds', 'Final votes']];
  state.stories.forEach((s, i) => {
    const last = s.history?.at(-1);
    rows.push([i + 1, s.title, s.estimate ?? '', s.history?.length ?? 0, last ? last.votes.map((v) => `${v.name}: ${v.value}`).join('; ') : '']);
  });
  const blob = new Blob([rows.map((r) => r.map(q).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.name.replace(/[^\w-]+/g, '_')}-estimates.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------- Global events ----------------
document.addEventListener('click', async (e) => {
  const card = e.target.closest('[data-card]');
  if (card) return vote(card.dataset.card);
  const saveBtn = e.target.closest('[data-save]');
  if (saveBtn) return action('saveEstimate', { value: saveBtn.dataset.save });
  const seatName = e.target.closest('.seat-name');
  if (seatName) return openSeatMenu(seatName.closest('.seat'));

  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  switch (btn.dataset.action) {
    case 'toggle-theme': return toggleTheme();
    case 'open-settings': return openSettings();
    case 'open-profile': return openProfile();
    case 'open-shortcuts': return $('#shortcuts-dialog').showModal();
    case 'toggle-sidebar': return $('#sidebar').classList.toggle('open');
    case 'export-csv': return exportCsv();
    case 'copy-link': if (await copy(inviteUrl())) toast('Invite link copied'); return;
    case 'reveal': return action('reveal');
    case 'reset': return action('reset');
    case 'nudge': action('nudge'); return toast('Nudged everyone who has not voted');
    case 'timer-menu': return openTimerMenu(btn);
    case 'timer-stop': return action('timerStop');
    case 'claim-host': return action('claimHost');
    case 'become-voter': return action('setRole', { role: 'voter' });
    case 'leave':
      if (!confirm('Leave this room?')) return;
      $('#profile-dialog').close();
      action('leave');
      await rt?.flush();
      LS.del(pidKey(roomId));
      return leaveToLanding();
  }
});

$('#copy-link').addEventListener('click', async () => {
  if (await copy(inviteUrl())) toast('Invite link copied — send it to your team');
});

document.addEventListener('keydown', (e) => {
  if (!state || $('#room').hidden) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  const cards = state.deck.cards;
  const k = e.key;
  if (/^[0-9]$/.test(k)) {
    const idx = k === '0' ? 9 : Number(k) - 1;
    if (cards[idx]) vote(cards[idx]);
  } else if (k === 'ArrowRight' || k === 'ArrowLeft') {
    e.preventDefault();
    const pickable = cards.length;
    const next = selectedHandIndex < 0 ? (k === 'ArrowRight' ? 0 : pickable - 1) : (selectedHandIndex + (k === 'ArrowRight' ? 1 : -1) + pickable) % pickable;
    vote(cards[next]) ;
  } else if (k === 'Escape') {
    closePopover();
    if (me()?.vote != null) vote(me().vote);
  } else if (k === 'r' || k === 'R') {
    if (canControl() && !state.revealed) action('reveal');
  } else if (k === 'n' || k === 'N') {
    if (canControl()) action('reset');
  } else if (k === 't' || k === 'T') {
    if (canControl()) action(state.timer ? 'timerStop' : 'timerStart', { seconds: state.settings.timerSeconds });
  } else if (k === 's' || k === 'S') {
    $('#sidebar').classList.toggle('open');
  } else if (k === '?') {
    $('#shortcuts-dialog').showModal();
  }
});

window.addEventListener('popstate', route);

// ---------------- Boot ----------------
function route() {
  const code = new URLSearchParams(location.search).get('room');
  if (code && /^[A-Za-z0-9]{6}$/.test(code)) {
    if (code.toUpperCase() !== roomId || !rt) enterRoom(code);
  } else {
    rt?.close();
    rt = null;
    roomId = null;
    state = null;
    showLanding();
  }
}

route();
