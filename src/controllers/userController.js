const prisma = require('../models/prismaClient');
const ApiError = require('../utils/ApiError');
const { onlineUsers } = require('../handlers/connectionHandler');

/**
 * Get current authenticated user's profile
 */
const getMe = async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, username: true, createdAt: true }
    });
    if (!user) throw new ApiError(404, 'User not found');
    res.status(200).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

/**
 * Get any user by ID
 */
const getUserById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, username: true, createdAt: true }
    });
    if (!user) throw new ApiError(404, 'User not found');
    const isOnline = onlineUsers.has(id);
    res.status(200).json({ success: true, data: { ...user, isOnline } });
  } catch (error) {
    next(error);
  }
};

/**
 * List all registered users (paginated)
 */
const listUsers = async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const skip = (page - 1) * limit;

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        select: { id: true, username: true, createdAt: true },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.user.count()
    ]);

    res.status(200).json({
      success: true,
      data: users,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) }
    });
  } catch (error) {
    next(error);
  }
};

/**
 * Get currently online users
 */
const getOnlineUsers = async (req, res, next) => {
  try {
    const users = Array.from(onlineUsers.entries()).map(([id, data]) => ({
      id,
      username: data.username,
      status: 'online'
    }));
    res.status(200).json({ success: true, data: users, meta: { count: users.length } });
  } catch (error) {
    next(error);
  }
};

/**
 * Update current user's username
 */
const updateMe = async (req, res, next) => {
  try {
    const { username } = req.body;
    if (!username || username.length < 3) {
      throw new ApiError(400, 'Username must be at least 3 characters');
    }

    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing && existing.id !== req.user.id) {
      throw new ApiError(409, 'Username already taken');
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { username },
      select: { id: true, username: true, createdAt: true }
    });

    res.status(200).json({ success: true, data: user });
  } catch (error) {
    next(error);
  }
};

/**
 * Delete current user's account
 */
const deleteMe = async (req, res, next) => {
  try {
    // Delete messages first (referential integrity)
    await prisma.message.deleteMany({
      where: { OR: [{ senderId: req.user.id }, { receiverId: req.user.id }] }
    });
    await prisma.user.delete({ where: { id: req.user.id } });

    res.status(200).json({ success: true, data: { message: 'Account deleted successfully' } });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMe,
  getUserById,
  listUsers,
  getOnlineUsers,
  updateMe,
  deleteMe,
};
