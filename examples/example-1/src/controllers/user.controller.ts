import type { Request, Response } from 'express';
import { sharding, getUserClient } from '../config/sharding.js';

export const UserController = {
  async create(req: Request, res: Response) {
    const db = sharding.randomShard();

    const user = await db.user.create({
      data: {
        name: req.body.name,
        email: req.body.email,
      },
    });

    res.status(201).json(user);
  },

  async me(req: Request, res: Response) {
    // In a real app this comes from JWT/session — here we use a simple header.
    const userId = req.header('x-user-id') as string;
    const db = await getUserClient(userId);

    const user = await db.user.findUnique({
      where: { id: userId },
      include: { projects: true },
    });

    res.json(user);
  },
};
