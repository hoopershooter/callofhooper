const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 8;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Call of Hooper multiplayer server is running.');
});

const io = new Server(httpServer, {
  cors: { origin: '*' }
});

const rooms = {}; // roomId -> { id, name, players: Map<socketId, {x,y,z,yaw}>, maxPlayers }
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

  socket.on('joinRoom', (roomId, callback) => {
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

    // send the new player the current state of everyone already here
    const existingPlayers = [];
    for (const [id, state] of room.players.entries()) {
      existingPlayers.push({ id, ...state });
    }

    room.players.set(socket.id, { x: 0, y: 1.7, z: 0, yaw: 0 });

    callback({ success: true, roomId, playerCount: room.players.size, maxPlayers: room.maxPlayers, existingPlayers });

    // tell everyone else already in the room that a new player joined
    socket.to(roomId).emit('playerJoined', { id: socket.id });

    broadcastRoomList();
  });

  socket.on('playerUpdate', (state) => {
    const roomId = socket.currentRoom;
    if (!roomId || !rooms[roomId]) return;
    rooms[roomId].players.set(socket.id, state);
    socket.to(roomId).emit('playerUpdate', { id: socket.id, ...state });
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
    if (rooms[roomId].players.size === 0) delete rooms[roomId];
    broadcastRoomList();
  }
});

httpServer.listen(PORT, () => {
  console.log('Server listening on port ' + PORT);
});
