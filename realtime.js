// Serverless rooms over free public MQTT brokers (secure WebSockets).
//
// Every message is AES-GCM encrypted with a key derived from the room code, and topic names
// are a hash of the code, so brokers only ever see scrambled bytes.
//
// One browser tab in each room is the "hub": it applies actions with the rules in room.js and
// publishes the room state as a retained message. Every other tab keeps a copy of that state,
// so when the hub leaves, the remaining tab with the lowest id takes over with nothing lost.
// The retained state also lets a room come back after everyone has left.

import { applyAction, maybeAutoReveal, pickNewHost, reveal } from './room.js';

export const BROKERS = ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
const HOST_HANDOFF_MS = 45_000;
const te = new TextEncoder();
const td = new TextDecoder();

export const netErr = (type) => Object.assign(new Error(type), { type });
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

async function roomKeys(code) {
  const h = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s)));
  const t = await h(`estimo-topic|${code}`);
  const base = `estimo1/${[...t.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  const key = await crypto.subtle.importKey('raw', await h(`estimo-key|${code}`), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { base, key };
}

async function seal(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return out;
}

async function unseal(key, buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u.length < 13) return null;
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u.slice(0, 12) }, key, u.slice(12));
    return JSON.parse(td.decode(pt));
  } catch {
    return null;
  }
}

function connectBroker(url, clientId, will) {
  return new Promise((resolve, reject) => {
    let c;
    try {
      c = window.mqtt.connect(url, { clientId, keepalive: 20, clean: true, reconnectPeriod: 2000, connectTimeout: 8000, will, protocolVersion: 4 });
    } catch {
      reject(netErr('broker'));
      return;
    }
    const t = setTimeout(() => { try { c.end(true); } catch {} reject(netErr('broker')); }, 9000);
    c.once('connect', () => { clearTimeout(t); resolve(c); });
    c.on('error', () => {});
  });
}

/**
 * Join (or create) a room.
 * create: a fresh room object from createRoom() when starting a new room.
 * Resolves with a controller once the room state is known.
 * Errors: 'lib' | 'crypto' | 'broker' | 'notfound' | 'taken'.
 */
export async function openRoom({ code, create = null, broker = 0, onState, onEvent, onStatus, onProgress = () => {} }) {
  if (typeof window.mqtt === 'undefined') throw netErr('lib');
  if (!window.crypto?.subtle) throw netErr('crypto');
  const { base, key } = await roomKeys(code);
  const clientId = `est-${hex(8)}`;
  const T = { state: `${base}/s`, act: `${base}/a`, ev: `${base}/e`, pres: `${base}/p/` };
  const presTopic = T.pres + clientId;
  const will = { topic: presTopic, payload: new Uint8Array(0), qos: 1, retain: true };

  let client = null;
  let brokerIndex = 0;
  let pid = null;
  let isHub = false;
  let hubClient = null;
  let lastPacket = null;
  let lastPacketAt = 0;
  let lastHubSeen = null;
  let closed = false;
  let electTimer = null;
  const presences = new Map(); // clientId -> { pid, hub }
  const suspects = new Set(); // hub candidates that never answered
  const voteKey = `estimo:vote:${code}`;
  let myVote = LS.get(voteKey); // { round, value }

  // Hub-only state.
  let room = null;
  const votes = new Map();
  let roundTimer = null;
  let handoffTimer = null;
  let broadcastTimer = null;
  const lastReact = new Map();

  let sendQ = Promise.resolve();
  let recvQ = Promise.resolve();
  const publish = (topic, obj, opts) => {
    sendQ = sendQ
      .then(async () => {
        if (!client) return;
        client.publish(topic, obj == null ? new Uint8Array(0) : await seal(key, obj), opts);
      })
      .catch(() => {});
    return sendQ;
  };
  const publishPresence = () => {
    presences.set(clientId, { pid, hub: isHub });
    return publish(presTopic, { pid, hub: isHub }, { qos: 1, retain: true });
  };
  const online = () => new Set([...presences.values()].map((p) => p.pid).filter(Boolean));
  const hubAlive = () => Boolean(hubClient && presences.get(hubClient)?.hub);

  // ---------- state delivery ----------
  function toView(packet) {
    const r = packet.room;
    const on = new Set(packet.online);
    const voted = new Set(packet.voted);
    const { players, ...rest } = r;
    return {
      ...rest,
      me: pid,
      serverNow: packet.now,
      players: Object.values(players)
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          role: p.role,
          connected: on.has(p.id),
          voted: voted.has(p.id),
          vote: r.revealed
            ? packet.revealedVotes?.[p.id] ?? null
            : p.id === pid && voted.has(p.id) ? myVote?.value ?? null : null,
        })),
    };
  }

  function deliver(packet) {
    lastPacket = packet;
    lastPacketAt = Date.now();
    LS.set(`estimo:backup:${code}`, packet);
    const r = packet.room;
    if (myVote && myVote.round !== r.round) {
      myVote = null;
      LS.set(voteKey, null);
    }
    // A hub that just took over does not know votes from the previous hub: send ours again.
    const hubChanged = lastHubSeen && packet.hub !== lastHubSeen;
    lastHubSeen = packet.hub;
    if (hubChanged && !isHub && pid && r.players[pid] && myVote?.value != null && !r.revealed && !packet.voted.includes(pid)) {
      publish(T.act, { f: clientId, pid, t: 'vote', d: { value: myVote.value } }, { qos: 1 });
    }
    onState(toView(packet));
  }

  // ---------- events ----------
  function handleEvent(ev) {
    if (Array.isArray(ev.to) && !ev.to.includes(pid) && !ev.to.includes(clientId)) return;
    onEvent(ev.t, ev.d ?? {});
  }
  function emitEvent(ev) {
    publish(T.ev, { f: clientId, ...ev }, { qos: 0 });
    handleEvent(ev);
  }

  // ---------- hub ----------
  const ctx = {
    get online() { return online(); },
    emit: (t, d, to) => emitEvent({ t, d, to }),
    armTimer,
    clearTimer: () => { clearTimeout(roundTimer); roundTimer = null; },
    canReact(p) {
      const now = Date.now();
      if (now - (lastReact.get(p) ?? 0) < 250) return false;
      lastReact.set(p, now);
      return true;
    },
  };

  function armTimer() {
    clearTimeout(roundTimer);
    if (!room?.timer) return;
    roundTimer = setTimeout(() => {
      if (!isHub || !room.timer) return;
      room.timer = null;
      if (!room.revealed) reveal(room, ctx);
      emitEvent({ t: 'toast', d: { text: '⏰ Time is up!' } });
      broadcast();
    }, Math.max(0, room.timer.endsAt - Date.now()));
  }

  function packetNow() {
    return {
      room,
      voted: [...votes.keys()],
      revealedVotes: room.revealed ? Object.fromEntries(votes) : null,
      online: [...online()],
      hub: clientId,
      now: Date.now(),
    };
  }

  function broadcast() {
    if (!isHub) return;
    clearTimeout(broadcastTimer);
    room.lastActive = Date.now();
    const packet = packetNow();
    publish(T.state, packet, { qos: 1, retain: true });
    deliver(structuredClone(packet));
  }

  function checkHandoff() {
    clearTimeout(handoffTimer);
    if (!room.hostId || online().has(room.hostId)) return;
    handoffTimer = setTimeout(() => {
      if (!isHub || online().has(room.hostId)) return;
      const next = pickNewHost(room, online());
      if (!next) return;
      room.hostId = next.id;
      emitEvent({ t: 'toast', d: { text: `${next.name} is now the facilitator` } });
      broadcast();
    }, HOST_HANDOFF_MS);
  }

  function hubPresenceChanged() {
    if (!isHub) return;
    maybeAutoReveal(room, votes, online(), ctx);
    checkHandoff();
    clearTimeout(broadcastTimer);
    broadcastTimer = setTimeout(broadcast, 250);
  }

  function handleAction(fromPid, fromClient, type, data) {
    if (!isHub) return;
    if (type === 'hello') return broadcast();
    if (typeof type !== 'string' || typeof fromPid !== 'string') return;
    try {
      if (applyAction(room, votes, fromPid, type, data ?? {}, ctx)) broadcast();
    } catch (err) {
      emitEvent({ t: 'error', d: { text: err.message }, to: [fromClient] });
    }
  }

  function becomeHub(packet, freshRoom = null) {
    clearTimeout(electTimer);
    isHub = true;
    hubClient = clientId;
    suspects.clear();
    room = freshRoom ?? structuredClone(packet.room);
    votes.clear();
    if (room.revealed && packet?.revealedVotes) {
      for (const [p, v] of Object.entries(packet.revealedVotes)) if (room.players[p]) votes.set(p, v);
    } else if (pid && room.players[pid] && myVote?.value != null && myVote.round === room.round) {
      votes.set(pid, myVote.value);
    }
    armTimer();
    publishPresence();
    checkHandoff();
    broadcast();
  }

  function stepDown(newHub) {
    isHub = false;
    hubClient = newHub;
    ctx.clearTimer();
    clearTimeout(handoffTimer);
    clearTimeout(broadcastTimer);
    room = null;
    votes.clear();
    publishPresence();
  }

  // ---------- election ----------
  function scheduleElection(delay = 1200) {
    clearTimeout(electTimer);
    electTimer = setTimeout(elect, delay);
  }

  function elect() {
    if (closed || isHub || hubAlive() || !lastPacket) return;
    const ids = [...presences.keys()].filter((id) => id === clientId || !suspects.has(id)).sort();
    if (ids[0] === clientId) return becomeHub(lastPacket);
    // Someone else should take over; if they never do, skip them.
    electTimer = setTimeout(() => {
      if (isHub || hubAlive()) return;
      suspects.add(ids[0]);
      elect();
    }, 4000);
  }

  // ---------- incoming ----------
  function onMessage(topic, payload) {
    recvQ = recvQ
      .then(async () => {
        if (closed) return;
        if (topic.startsWith(T.pres)) {
          const id = topic.slice(T.pres.length);
          if (id === clientId) return;
          if (!payload?.length) {
            presences.delete(id);
            if (id === hubClient) {
              hubClient = null;
              scheduleElection();
            }
            hubPresenceChanged();
            return;
          }
          const m = await unseal(key, payload);
          if (!m || typeof m !== 'object') return;
          presences.set(id, { pid: typeof m.pid === 'string' ? m.pid : null, hub: Boolean(m.hub) });
          if (m.hub) {
            suspects.delete(id);
            if (isHub) {
              // Two hubs: the lower id wins.
              if (id < clientId) stepDown(id);
            } else if (!hubAlive() || id < hubClient) {
              hubClient = id;
              clearTimeout(electTimer);
            }
          } else if (id === hubClient) {
            hubClient = null;
            scheduleElection();
          }
          hubPresenceChanged();
          return;
        }

        const m = await unseal(key, payload);
        if (!m || typeof m !== 'object') return;
        if (topic === T.state) {
          if (m.hub === clientId || !m.room) return;
          if (isHub) {
            if (m.hub < clientId && presences.get(m.hub)?.hub) stepDown(m.hub);
            else return;
          }
          deliver(m);
        } else if (topic === T.act) {
          if (isHub && m.f !== clientId) handleAction(m.pid, m.f, m.t, m.d);
        } else if (topic === T.ev) {
          if (m.f !== clientId && typeof m.t === 'string') handleEvent(m);
        }
      })
      .catch((err) => console.error(err));
  }

  // ---------- connect ----------
  const order = [broker, ...BROKERS.keys()].filter((v, i, a) => BROKERS[v] && a.indexOf(v) === i);
  const backup = create ? null : LS.get(`estimo:backup:${code}`);
  let connectedAny = false;
  for (const [n, bi] of order.entries()) {
    let c;
    onProgress(n === 0 ? 'connecting' : 'retrying');
    try {
      c = await connectBroker(BROKERS[bi], clientId, will);
    } catch {
      continue;
    }
    connectedAny = true;
    client = c;
    brokerIndex = bi;
    c.on('message', onMessage);
    await new Promise((r) => c.subscribe([T.state, T.act, T.ev, `${T.pres}+`], { qos: 1 }, () => r()));
    onProgress(create ? 'creating' : 'searching');
    // Retained state and presences arrive right after subscribing. Joiners stop waiting as soon as
    // they have both; creators only need a short check that the code is unused.
    const t0 = Date.now();
    const maxWait = create ? 600 : 1500;
    while (Date.now() - t0 < maxWait) {
      await sleep(100);
      await recvQ;
      if (!create && lastPacket && hubClient) break;
    }
    if (create) {
      if (lastPacket || presences.size) {
        c.end(true);
        throw netErr('taken');
      }
      break;
    }
    if (hubClient || lastPacket) break;
    // Nothing on this broker. Keep the connection on the last one if we can restore from a local copy.
    if (n === order.length - 1 && backup?.room) break;
    c.end(true);
    client = null;
    presences.clear();
  }
  if (!client) throw netErr(connectedAny ? 'notfound' : 'broker');

  let firstConnect = true;
  client.on('connect', () => {
    if (firstConnect) return;
    publishPresence();
    if (isHub) broadcast();
    onStatus?.(true);
  });
  firstConnect = false;
  client.on('offline', () => onStatus?.(false));
  client.on('close', () => !closed && onStatus?.(false));

  if (create) {
    becomeHub(null, create);
  } else {
    publishPresence();
    if (!lastPacket && backup?.room) lastPacket = backup;
    if (lastPacket) deliver(lastPacket);
    if (hubClient) {
      // Make sure the hub is really there (its presence could be stale).
      onProgress('syncing');
      const asked = Date.now();
      publish(T.act, { f: clientId, pid, t: 'hello', d: {} }, { qos: 1 });
      for (let i = 0; i < 40 && !(lastPacketAt > asked && lastPacket?.hub === hubClient) && !isHub; i++) await sleep(100);
      if (!isHub && !(lastPacketAt > asked && lastPacket?.hub === hubClient)) {
        suspects.add(hubClient);
        hubClient = null;
        elect();
      }
    } else {
      elect();
    }
  }

  const leaveNow = () => {
    if (closed) return;
    closed = true;
    clearTimeout(electTimer);
    clearTimeout(roundTimer);
    clearTimeout(handoffTimer);
    clearTimeout(broadcastTimer);
    try {
      client.publish(presTopic, new Uint8Array(0), { qos: 0, retain: true });
      client.end(false);
    } catch {}
  };
  window.addEventListener('pagehide', leaveNow);

  return {
    brokerIndex,
    get isHub() { return isHub; },
    view: () => (lastPacket ? toView(lastPacket) : null),
    setPid(p) {
      pid = p;
      publishPresence();
      if (isHub) hubPresenceChanged();
      else if (lastPacket) deliver(lastPacket);
    },
    act(type, data = {}) {
      if (closed || !pid) return;
      if (type === 'vote') {
        myVote = { round: lastPacket?.room.round, value: data.value ?? null };
        LS.set(voteKey, myVote);
      }
      if (isHub) handleAction(pid, clientId, type, data);
      else publish(T.act, { f: clientId, pid, t: type, d: data }, { qos: 1 });
    },
    async flush() {
      await sendQ;
    },
    close() {
      window.removeEventListener('pagehide', leaveNow);
      leaveNow();
    },
  };
}
