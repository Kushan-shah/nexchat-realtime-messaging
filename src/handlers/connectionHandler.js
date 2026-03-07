const presenceService = require('../services/presenceService');
const logger = require('../utils/logger');

// In-memory store of online users for broadcasting
const onlineUsers = new Map(); // userId -> { username, socketCount }
// In-memory global chat cache (Max 100 messages)
const globalChatHistory = [];

function handleConnection(socket, io) {
  const userId = socket.user.id;
  const username = socket.user.username;
  logger.info({ socketId: socket.id, userId, username }, 'User connected to socket');

  // Reference-counted socket tracking (supports multi-tab without false offline)
  const existing = onlineUsers.get(userId);
  if (existing) {
    existing.socketCount++;
  } else {
    onlineUsers.set(userId, { username, socketCount: 1 });
  }

  // Mark online in Redis
  presenceService.setUserOnline(userId, socket.id);

  // Auto-join the global chat room and a personal room for multi-tab support
  socket.join('global');
  socket.join(`user_${userId}`); // All tabs open by this user will join this room

  // Hydrate global lobby history immediately upon refresh
  socket.emit('global_history', globalChatHistory);

  // Broadcast updated online users list to everyone
  broadcastOnlineUsers(io);

  // Broadcast presence to all
  io.emit('presence_update', { userId, username, status: 'online' });

  // Handle joining a private DM session
  socket.on('join_dm', (data) => {
    const { targetUserId } = data;
    const roomId = getDMRoomId(userId, targetUserId);
    
    socket.join(roomId);
    logger.info({ userId, targetUserId, roomId }, 'User joined DM room');

    // Notify the target user to auto-join the same room
    const targetUser = onlineUsers.get(targetUserId);
    if (targetUser) {
      // Emit to ALL tabs the target user has open!
      io.to(`user_${targetUserId}`).emit('dm_request', {
        fromUserId: userId,
        fromUsername: username,
        roomId
      });
    }
  });

  // Handle accepting/auto-joining a DM room (triggered by dm_request)
  socket.on('join_room', (roomId) => {
    socket.join(roomId);
    logger.info({ userId, roomId }, 'User joined room');
  });

  // Handle typing indicators
  socket.on('typing_start', (data) => {
    const { targetUserId, roomId } = data;
    const targetRoomId = roomId || getDMRoomId(userId, targetUserId);
    socket.to(targetRoomId).emit('user_typing', { userId, username });
  });

  socket.on('typing_stop', (data) => {
    const { targetUserId, roomId } = data;
    const targetRoomId = roomId || getDMRoomId(userId, targetUserId);
    socket.to(targetRoomId).emit('user_stopped_typing', { userId, username });
  });
}

function handleDisconnect(socket, io) {
  const userId = socket.user.id;
  const username = socket.user.username;
  logger.info({ socketId: socket.id, userId }, 'User disconnected');

  // Decrement socket count; only mark offline when ALL tabs are closed
  const entry = onlineUsers.get(userId);
  if (entry) {
    entry.socketCount--;
    if (entry.socketCount <= 0) {
      onlineUsers.delete(userId);
      // Only broadcast offline when truly no sockets remain
      io.emit('presence_update', { userId, username, status: 'offline' });
    }
  }

  // Remove presence
  presenceService.setUserOffline(userId, socket.id);

  // Broadcast updated list
  broadcastOnlineUsers(io);
}

function broadcastOnlineUsers(io) {
  const usersList = Array.from(onlineUsers.entries()).map(([id, data]) => ({
    id,
    username: data.username
  }));
  io.emit('online_users', usersList);
}

/**
 * Generates a deterministic room ID for two users.
 * Always the same regardless of who initiates.
 */
function getDMRoomId(userA, userB) {
  return [userA, userB].sort().join('__');
}

module.exports = {
  handleConnection,
  handleDisconnect,
  onlineUsers,
  getDMRoomId,
  globalChatHistory
};
