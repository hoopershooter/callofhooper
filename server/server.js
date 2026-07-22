const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 8;
const RESPAWN_DELAY_MS = 3000;
const SPAWN_PROTECTION_MS = 3000;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Call of Hooper multiplayer server is running.');
});

const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const rooms = {}; // roomId -> { id, name, players: Map<socketId, {...,kills,deaths}>, maxPlayers }
let nextRoomId = 1;

function roomSummaries() {
  return Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    playerCount: r.players.size,
    maxPlayers: r.maxPlayers
  }));
}

function broadcastRoomList() {
  io.emit('roomList', roomSummaries());
}

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

  socket.on('listRooms', (callback) => {
    callback(roomSummaries());
  });

  socket.on('createRoom', (name, callback) => {
    const roomId = 'room-' + (nextRoomId++);
    const safeName = (name && name.trim()) ? name.trim().slice(0, 30) : ('Server ' + roomId);
    rooms[roomId] = { id: roomId, name: safeName, players: new Map(), maxPlayers: MAX_PLAYERS_PER_ROOM };
    callback({ success: true, roomId });
    broadcastRoomList();
  });

  socket.on('joinRoom', (data, callback) => {
    const roomId = data && data.roomId;
    const character = (data && data.character) || 1;
    const username = ((data && data.username) || 'Player').toString().trim().slice(0, 16) || 'Player';
    const room = rooms[roomId];
    if (!room) {
      callback({ success: false, reason: 'Room no longer exists.' });
      return;
    }
    if (room.players.size >= room.maxPlayers) {
      callback({ success: false, reason: 'Room is full.' });
      return;
    }

    socket.join(roomId);
    socket.currentRoom = roomId;

    const existingPlayers = [];
    for (const [id, state] of room.players.entries()) {
      existingPlayers.push({ id, ...state });
    }

    room.players.set(socket.id, {
      x: 0, y: 1.7, z: 0, yaw: 0, character, username,
      alive: true, invulnerableUntil: Date.now() + SPAWN_PROTECTION_MS,
      kills: 0, deaths: 0
    });

    callback({ success: true, roomId, playerCount: room.players.size, maxPlayers: room.maxPlayers, existingPlayers });

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
      targetId,
      killerId: socket.id,
      killerUsername: killer.username,
      targetUsername: target.username
    });

    broadcastLeaderboard(roomId);

    setTimeout(() => {
      if (!rooms[roomId]) return;
      const t = rooms[roomId].players.get(targetId);
      if (!t) return;
      t.alive = true;
      t.x = 0; t.y = 1.7; t.z = 0; t.yaw = 0;
      t.invulnerableUntil = Date.now() + SPAWN_PROTECTION_MS;
      io.to(roomId).emit('playerRespawned', { id: targetId, x: 0, y: 1.7, z: 0 });
    }, RESPAWN_DELAY_MS);
  });

  socket.on('leaveRoom', () => leaveCurrentRoom(socket));
  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    leaveCurrentRoom(socket);
  });

  function leaveCurrentRoom(socket) {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return;
    rooms[roomId].players.delete(socket.id);
    socket.leave(roomId);
    socket.to(roomId).emit('playerLeft', { id: socket.id });
    socket.currentRoom = null;
    if (rooms[roomId].players.size === 0) {
      delete rooms[roomId];
    } else {
      broadcastLeaderboard(roomId);
    }
    broadcastRoomList();
  }
});

httpServer.listen(PORT, () => {
  console.log('Server listening on port ' + PORT);
});
