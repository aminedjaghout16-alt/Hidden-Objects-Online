const { WebSocketServer, WebSocket } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// ─── State ────────────────────────────────────────────────────────────────────
const players = new Map();   // socketId → player object
const rooms   = new Map();   // roomCode → room object
const queue   = [];          // players waiting for matchmaking

// ─── Helpers ─────────────────────────────────────────────────────────────────
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function broadcast(room, type, payload = {}, excludeId = null) {
  for (const pid of room.players) {
    const p = players.get(pid);
    if (p && p.id !== excludeId) send(p.ws, type, payload);
  }
}

function roomPublicState(room) {
  return {
    code: room.code,
    map: room.map,
    timeLimit: room.timeLimit,
    maxPlayers: room.maxPlayers,
    phase: room.phase,
    players: room.players.map(pid => {
      const p = players.get(pid);
      return p ? { id: p.id, name: p.name, level: p.level, role: p.role, alive: p.alive } : null;
    }).filter(Boolean),
  };
}

function createRoom(code, settings = {}) {
  return {
    code,
    map: settings.map || 'Office Complex',
    timeLimit: settings.timeLimit || 180,
    maxPlayers: settings.maxPlayers || 8,
    phase: 'lobby',      // lobby | hiding | hunting | ended
    players: [],
    hostId: null,
    hideTimer: null,
    huntTimer: null,
    createdAt: Date.now(),
  };
}

function assignRoles(room) {
  const ids = [...room.players];
  // First player is hunter if only 2, else 1 hunter per 3 hiders
  const hunterCount = Math.max(1, Math.floor(ids.length / 4));
  const shuffled = ids.sort(() => Math.random() - 0.5);
  shuffled.forEach((pid, i) => {
    const p = players.get(pid);
    if (p) {
      p.role = i < hunterCount ? 'hunter' : 'hider';
      p.alive = true;
    }
  });
}

function startGame(room) {
  if (room.players.length < 2) return;

  assignRoles(room);
  room.phase = 'hiding';

  broadcast(room, 'GAME_STARTED', { room: roomPublicState(room) });

  // Hiding phase: 30 seconds
  room.hideTimer = setTimeout(() => {
    room.phase = 'hunting';
    broadcast(room, 'HUNTING_STARTED', { room: roomPublicState(room) });

    // Hunt phase: timeLimit seconds
    room.huntTimer = setTimeout(() => endGame(room, 'hiders'), room.timeLimit * 1000);
  }, 30_000);
}

function endGame(room, winner) {
  clearTimeout(room.hideTimer);
  clearTimeout(room.huntTimer);
  room.phase = 'ended';

  // Calculate XP
  const xpMap = { hunter: { win: 200, lose: 50 }, hider: { win: 150, lose: 30 } };
  room.players.forEach(pid => {
    const p = players.get(pid);
    if (!p) return;
    const won = (winner === 'hunters' && p.role === 'hunter') || (winner === 'hiders' && p.role === 'hider');
    const xpGain = xpMap[p.role][won ? 'win' : 'lose'];
    p.xp += xpGain;
    p.wins += won ? 1 : 0;
    p.losses += won ? 0 : 1;
    // Level up every 1000 XP
    while (p.xp >= p.xpToNext) { p.xp -= p.xpToNext; p.level++; p.xpToNext = p.level * 1000; }
    send(p.ws, 'STATS_UPDATED', { xp: p.xp, level: p.level, xpToNext: p.xpToNext, wins: p.wins, losses: p.losses, xpGained: xpGain, won });
  });

  broadcast(room, 'GAME_ENDED', { winner, room: roomPublicState(room) });

  // Clean up room after 30s
  setTimeout(() => {
    room.players.forEach(pid => {
      const p = players.get(pid);
      if (p) p.roomCode = null;
    });
    rooms.delete(room.code);
  }, 30_000);
}

function removePlayerFromRoom(player) {
  if (!player.roomCode) return;
  const room = rooms.get(player.roomCode);
  if (!room) return;
  room.players = room.players.filter(id => id !== player.id);
  player.roomCode = null;

  if (room.players.length === 0) {
    clearTimeout(room.hideTimer);
    clearTimeout(room.huntTimer);
    rooms.delete(room.code);
    return;
  }

  // Transfer host
  if (room.hostId === player.id) room.hostId = room.players[0];

  broadcast(room, 'PLAYER_LEFT', { playerId: player.id, room: roomPublicState(room) });

  // Check win condition
  if (room.phase === 'hunting') {
    const alivePlayers = room.players.map(pid => players.get(pid)).filter(Boolean);
    const aliveHiders = alivePlayers.filter(p => p.role === 'hider' && p.alive);
    if (aliveHiders.length === 0) endGame(room, 'hunters');
  }
}

function tryMatchmaking() {
  while (queue.length >= 2) {
    const p1 = queue.shift();
    const p2 = queue.shift();
    if (!players.has(p1) || !players.has(p2)) continue;

    const code = generateRoomCode();
    const room = createRoom(code);
    rooms.set(code, room);

    [p1, p2].forEach(pid => {
      const p = players.get(pid);
      p.roomCode = code;
      room.players.push(pid);
    });
    room.hostId = p1;

    broadcast(room, 'MATCH_FOUND', { room: roomPublicState(room) });
    setTimeout(() => startGame(room), 5000);
  }
}

// ─── Connection handler ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const socketId = uuidv4();
  const player = {
    id: socketId,
    ws,
    name: `Operative_${Math.floor(Math.random() * 9000) + 1000}`,
    level: 1,
    xp: 0,
    xpToNext: 1000,
    wins: 0,
    losses: 0,
    role: null,
    alive: true,
    roomCode: null,
    inQueue: false,
  };
  players.set(socketId, player);

  send(ws, 'CONNECTED', {
    id: socketId,
    name: player.name,
    level: player.level,
    xp: player.xp,
    xpToNext: player.xpToNext,
    wins: player.wins,
    losses: player.losses,
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, payload = {} } = msg;

    switch (type) {

      case 'SET_NAME': {
        const name = String(payload.name || '').trim().slice(0, 20);
        if (name) player.name = name;
        send(ws, 'NAME_SET', { name: player.name });
        break;
      }

      case 'JOIN_QUEUE': {
        if (player.inQueue || player.roomCode) return;
        player.inQueue = true;
        queue.push(socketId);
        send(ws, 'IN_QUEUE', { position: queue.length });
        tryMatchmaking();
        break;
      }

      case 'LEAVE_QUEUE': {
        const qi = queue.indexOf(socketId);
        if (qi !== -1) queue.splice(qi, 1);
        player.inQueue = false;
        send(ws, 'LEFT_QUEUE', {});
        break;
      }

      case 'CREATE_ROOM': {
        if (player.roomCode) return;
        const code = generateRoomCode();
        const room = createRoom(code, payload);
        room.hostId = socketId;
        room.players.push(socketId);
        rooms.set(code, room);
        player.roomCode = code;
        send(ws, 'ROOM_CREATED', { room: roomPublicState(room) });
        break;
      }

      case 'JOIN_ROOM': {
        const code = String(payload.code || '').toUpperCase();
        const room = rooms.get(code);
        if (!room) { send(ws, 'ERROR', { message: 'Room not found.' }); return; }
        if (room.players.length >= room.maxPlayers) { send(ws, 'ERROR', { message: 'Room is full.' }); return; }
        if (room.phase !== 'lobby') { send(ws, 'ERROR', { message: 'Game already in progress.' }); return; }
        if (player.roomCode) return;

        room.players.push(socketId);
        player.roomCode = code;
        send(ws, 'ROOM_JOINED', { room: roomPublicState(room) });
        broadcast(room, 'PLAYER_JOINED', { room: roomPublicState(room) }, socketId);
        break;
      }

      case 'LEAVE_ROOM': {
        removePlayerFromRoom(player);
        send(ws, 'LEFT_ROOM', {});
        break;
      }

      case 'START_GAME': {
        const room = rooms.get(player.roomCode);
        if (!room || room.hostId !== socketId) return;
        if (room.phase !== 'lobby') return;
        startGame(room);
        break;
      }

      case 'ELIMINATE': {
        // Hunter marks a hider as eliminated
        const room = rooms.get(player.roomCode);
        if (!room || room.phase !== 'hunting' || player.role !== 'hunter') return;
        const target = players.get(payload.targetId);
        if (!target || target.roomCode !== player.roomCode || target.role !== 'hider' || !target.alive) return;

        target.alive = false;
        broadcast(room, 'PLAYER_ELIMINATED', { playerId: target.id, eliminatedBy: socketId, room: roomPublicState(room) });

        const aliveHiders = room.players.map(pid => players.get(pid)).filter(p => p && p.role === 'hider' && p.alive);
        if (aliveHiders.length === 0) endGame(room, 'hunters');
        break;
      }

      case 'CHAT': {
        const room = rooms.get(player.roomCode);
        if (!room) return;
        const text = String(payload.text || '').trim().slice(0, 200);
        if (!text) return;
        broadcast(room, 'CHAT_MESSAGE', { from: player.name, text, playerId: socketId });
        break;
      }
    }
  });

  ws.on('close', () => {
    const qi = queue.indexOf(socketId);
    if (qi !== -1) queue.splice(qi, 1);
    removePlayerFromRoom(player);
    players.delete(socketId);
  });
});

console.log(`🎮 Prop Hunt Protocol server running on port ${PORT}`);
