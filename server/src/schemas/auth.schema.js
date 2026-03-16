const { z } = require('zod');

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(255),
});

module.exports = { loginSchema };
