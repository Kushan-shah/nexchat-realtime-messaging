const prisma = require('../models/prismaClient');
const ApiError = require('../utils/ApiError');

/**
 * Fetch chat history using Cursor-based pagination.
 * O(log N) via indexed createdAt instead of O(N) offset.
 */
const getHistory = async (req, res, next) => {
  try {
    const { userId: otherUserId } = req.params;
    const currentUserId = req.user.id;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const cursor = req.query.cursor;

    if (!otherUserId) throw new ApiError(400, 'User ID parameter is required');

    const whereClause = {
      OR: [
        { senderId: currentUserId, receiverId: otherUserId },
        { senderId: otherUserId, receiverId: currentUserId }
      ],
      ...(cursor && { createdAt: { lt: new Date(cursor) } })
    };

    const messages = await prisma.message.findMany({
      where: whereClause,
      take: limit,
      orderBy: { createdAt: 'desc' }
    });

    const nextCursor = messages.length === limit ? messages[messages.length - 1].createdAt : null;

    res.status(200).json({
      success: true,
      data: { messages, nextCursor, count: messages.length }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get all conversations (unique users you've chatted with)
 */
const getConversations = async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Get distinct user IDs from messages
    const sent = await prisma.message.findMany({
      where: { senderId: userId },
      select: { receiverId: true },
      distinct: ['receiverId']
    });
    const received = await prisma.message.findMany({
      where: { receiverId: userId },
      select: { senderId: true },
      distinct: ['senderId']
    });

    const partnerIds = [...new Set([
      ...sent.map(m => m.receiverId),
      ...received.map(m => m.senderId)
    ])];

    // Get latest message for each conversation
    const conversations = await Promise.all(partnerIds.map(async (partnerId) => {
      const partner = await prisma.user.findUnique({
        where: { id: partnerId },
        select: { id: true, username: true }
      });
      const lastMessage = await prisma.message.findFirst({
        where: {
          OR: [
            { senderId: userId, receiverId: partnerId },
            { senderId: partnerId, receiverId: userId }
          ]
        },
        orderBy: { createdAt: 'desc' }
      });
      const unreadCount = await prisma.message.count({
        where: { senderId: partnerId, receiverId: userId, status: { not: 'READ' } }
      });
      return {
        partner,
        lastMessage,
        unreadCount
      };
    }));

    // Sort by latest message
    conversations.sort((a, b) => 
      new Date(b.lastMessage?.createdAt || 0) - new Date(a.lastMessage?.createdAt || 0)
    );

    res.status(200).json({ success: true, data: conversations });
  } catch (error) {
    next(error);
  }
};

/**
 * Get unread message count
 */
const getUnreadCount = async (req, res, next) => {
  try {
    const count = await prisma.message.count({
      where: { receiverId: req.user.id, status: { not: 'READ' } }
    });
    res.status(200).json({ success: true, data: { unreadCount: count } });
  } catch (error) {
    next(error);
  }
};

/**
 * Mark messages as read
 */
const markAsRead = async (req, res, next) => {
  try {
    const { senderId } = req.params;
    const updated = await prisma.message.updateMany({
      where: {
        senderId,
        receiverId: req.user.id,
        status: { not: 'READ' }
      },
      data: { status: 'READ' }
    });
    res.status(200).json({ success: true, data: { markedRead: updated.count } });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete a specific message (only sender can delete)
 */
const deleteMessage = async (req, res, next) => {
  try {
    const { messageId } = req.params;
    const message = await prisma.message.findUnique({ where: { id: messageId } });

    if (!message) throw new ApiError(404, 'Message not found');
    if (message.senderId !== req.user.id) throw new ApiError(403, 'You can only delete your own messages');

    await prisma.message.delete({ where: { id: messageId } });
    res.status(200).json({ success: true, data: { message: 'Message deleted' } });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getHistory,
  getConversations,
  getUnreadCount,
  markAsRead,
  deleteMessage,
};
