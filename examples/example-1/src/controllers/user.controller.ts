import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sharding } from '../config/sharding.js';

export const UserController = {
  async create(req: Request, res: Response) {
    const id = randomUUID();
    const db = await sharding.allocateShard(id);

    const user = await db.user.create({
      data: {
        id,
        name: req.body.name,
        email: req.body.email
      }
    });

    res.status(201).json(user);
  },

  async getById(req: Request, res: Response) {
    const db = await sharding.resolveShard(req.params.id);

    const user = await db.user.findUnique({
      where: { id: req.params.id },
      include: { projects: true }
    });

    res.json(user);
  }
};
