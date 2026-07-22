const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 8;
const RESPAWN_DELAY_MS = 3000;
const SPAWN_PROTECTION_MS = 3000;
const ADMIN_KEY = "hooper-admin-2026";

const SPAWN_POINTS = {
  city: [
    { x: 8.5, z: 0 }, { x: 26.9, z: 26.9 }, { x: 0, z: 17.5 }, { x: -5.3, z: 5.3 },
    { x: -28.5, z: 0 }, { x: -27.2, z: -27.2 }, { x: 0, z: -35.5 }, { x: 25.1, z: -25.1 }
  ],
  grove: [
    { x: 388, z: 412 }, { x: 400, z: 414 }, { x: 412, z: 412 },
    { x: 388, z: 388 }, { x: 400, z: 386 }, { x: 412, z: 388 }
  ]
};
const MAP_NAMES = { city: 'City', grove: 'Warkworth Grove' };

function pickSpawnPoint(room, excludeId) {
  const points = SPAWN_POINTS[room.mapId] || SPAWN_POINTS.city;
  let best = points[0];
  let bestScore = -Infinity;
  for (const sp of points) {
    let minDist = Infinity;
    for (const [id, p] of room.players.entries()) {
      if (id === excludeId) continue;
      if (p.alive === false) continue;
      const dx = sp.x - p.x, dz = sp.z - p.z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist < minDist) minDist = dist;
    }
    if (minDist === Infinity) minDist = 999;
    const score = minDist + Math.random() * 5;
    if (score > bestScore) { bestScore = score; best = sp; }
  }
  return best;
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + req.headers.host);
  if (url.pathname === '/admin/refresh') {
    if (url.searchParams.get('key') !== ADMIN_KEY) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden — wrong or missing key.');
      return;
    }
    io.emit('forceRefresh');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Refresh signal sent to all connected players.');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Call of Hooper multiplayer server is running.');
});

const io = new Server(httpServer, { cors: { origin: '*' } });

const rooms = {};
let nextRoomId = 1;

function roomSummaries() {
  return Object.values(rooms).map(r => ({
    id: r.id, name: r.name, playerCount: r.players.size, maxPlayers: r.maxPlayers,
    mapId: r.mapId, mapName: MAP_NAMES[r.mapId] || 'City'
  }));
}

function broadcastRoomList() { io.emit('roomList', roomSummaries()); }

function leaderboardFor(room) {
  const list = [];
  for (const [id, p] of room.players.entries()) {
    list.push({ id, username: p.username, kills: p.kills || 0, deaths: p.deaths || 0 });
  }
  list.sort((a, b) => b.kills - a.kills);
  return list;
}
function broadcastLeaderboard(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  io.to(roomId).emit('leaderboardUpdate', leaderboardFor(room));
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('listRooms', (callback) => callback(roomSummaries()));

  socket.on('createRoom', (data, callback) => {
    const name = (typeof data === 'string') ? data : (data && data.name);
    const mapId = (data && data.mapId === 'grove') ? 'grove' : 'city';
    const roomId = 'room-' + (nextRoomId++);
    const safeName = (name && name.trim()) ? name.trim().slice(0, 30) : ('Server ' + roomId);
    rooms[roomId] = { id: roomId, name: safeName, mapId, players: new Map(), maxPlayers: MAX_PLAYERS_PER_ROOM };
    callback({ success: true, roomId });
    broadcastRoomList();
  });

  socket.on('joinRoom', (data, callback) => {
    const roomId = data && data.roomId;
    const character = (data && data.character) || 1;
    const username = ((data && data.username) || 'Player').toString().trim().slice(0, 16) || 'Player';
    const room = rooms[roomId];
    if (!room) { callback({ success: false, reason: 'Room no longer exists.' }); return; }
    if (room.players.size >= room.maxPlayers) { callback({ success: false, reason: 'Room is full.' }); return; }

    socket.join(roomId);
    socket.currentRoom = roomId;

    const existingPlayers = [];
    for (const [id, state] of room.players.entries()) existingPlayers.push({ id, ...state });

    const spawn = pickSpawnPoint(room, socket.id);
    room.players.set(socket.id, {
      x: spawn.x, y: 1.7, z: spawn.z, yaw: 0, character, username,
      alive: true, invulnerableUntil: Date.now() + SPAWN_PROTECTION_MS, kills: 0, deaths: 0
    });

    callback({
      success: true, roomId, playerCount: room.players.size, maxPlayers: room.maxPlayers,
      existingPlayers, spawnX: spawn.x, spawnZ: spawn.z, mapId: room.mapId
    });

    socket.to(roomId).emit('playerJoined', { id: socket.id, character, username });
    broadcastRoomList();
    broadcastLeaderboard(roomId);
  });

  socket.on('playerUpdate', (state) => {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return;
    const existing = rooms[roomId].players.get(socket.id) || {};
    rooms[roomId].players.set(socket.id, { ...existing, ...state });
    socket.to(roomId).emit('playerUpdate', { id: socket.id, ...state });
  });

  socket.on('shotFired', (data) => {
    const roomId = socket.currentRoom;
    if (!roomId) return;
    socket.to(roomId).emit('shotFired', { id: socket.id, ...data });
  });

  socket.on('voiceSignal', (data) => {
    const roomId = socket.currentRoom;
    if (!roomId || !data || !data.targetId) return;
    const targetSocket = io.sockets.sockets.get(data.targetId);
    if (!targetSocket || targetSocket.currentRoom !== roomId) return;
    targetSocket.emit('voiceSignal', { id: socket.id, signal: data.signal });
  });

  socket.on('hitPlayer', (data) => {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return;
    const room = rooms[roomId];
    const targetId = data && data.targetId;
    const target = room.players.get(targetId);
    const killer = room.players.get(socket.id);
    if (!target || !killer) return;
    if (target.alive === false) return;
    if (Date.now() < (target.invulnerableUntil || 0)) return;

    target.alive = false;
    target.deaths = (target.deaths || 0) + 1;
    killer.kills = (killer.kills || 0) + 1;

    io.to(roomId).emit('playerKilled', {
      targetId, killerId: socket.id, killerUsername: killer.username, targetUsername: target.username
    });
    broadcastLeaderboard(roomId);

    setTimeout(() => {
      if (!rooms[roomId]) return;
      const t = rooms[roomId].players.get(targetId);
      if (!t) return;
      const respawnPoint = pickSpawnPoint(rooms[roomId], targetId);
      t.alive = true;
      t.x = respawnPoint.x; t.y = 1.7; t.z = respawnPoint.z; t.yaw = 0;
      t.invulnerableUntil = Date.now() + SPAWN_PROTECTION_MS;
      io.to(roomId).emit('playerRespawned', { id: targetId, x: respawnPoint.x, z: respawnPoint.z });
    }, RESPAWN_DELAY_MS);
  });

  socket.on('leaveRoom', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => { console.log('Player disconnected:', socket.id); leaveCurrentRoom(socket); });

  function leaveCurrentRoom(socket) {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return;
    rooms[roomId].players.delete(socket.id);
    socket.leave(roomId);
    socket.to(roomId).emit('playerLeft', { id: socket.id });
    socket.currentRoom = null;
    if (rooms[roomId].players.size === 0) delete rooms[roomId];
    else broadcastLeaderboard(roomId);
    broadcastRoomList();
  }
});

httpServer.listen(PORT, () => console.log('Server listening on port ' + PORT));
