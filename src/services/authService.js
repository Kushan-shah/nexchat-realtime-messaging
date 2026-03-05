const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const prisma = require('../models/prismaClient');
const ApiError = require('../utils/ApiError');
const { env } = require('../config');

const generateToken = (payload) => {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN });
};

async function registerUser(username, password) {
  const existingUser = await prisma.user.findUnique({ where: { username } });
  if (existingUser) {
    throw new ApiError(400, 'Username already taken');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: {
      username,
      passwordHash,
    },
  });

  const token = generateToken({ id: user.id, username: user.username });
  
  // Omit passwordHash from response
  delete user.passwordHash;
  return { user, token };
}

async function loginUser(username, password) {
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    throw new ApiError(401, 'Invalid username or password');
  }

  const isValid = await bcrypt.compare(password, user.passwordHash);
  if (!isValid) {
    throw new ApiError(401, 'Invalid username or password');
  }

  const token = generateToken({ id: user.id, username: user.username });
  
  delete user.passwordHash;
  return { user, token };
}

module.exports = {
  registerUser,
  loginUser,
};
