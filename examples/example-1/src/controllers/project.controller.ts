import type { Request, Response } from 'express';
import { getUserClient } from '../config/sharding.js';

export const ProjectController = {
  async create(req: Request, res: Response) {
    // In a real app this comes from JWT/session — here we use a simple header.
    const userId = req.header('x-user-id') as string;
    const db = await getUserClient(userId);

    const project = await db.project.create({
      data: {
        name: req.body.name,
        userId,
      },
    });

    res.status(201).json(project);
  },

  async getById(req: Request, res: Response) {
    // In a real app this comes from JWT/session — here we use a simple header.
    const userId = req.header('x-user-id') as string;
    const db = await getUserClient(userId);

    const project = await db.project.findFirst({
      where: {
        id: req.params.id,
        userId,
      },
    });

    res.json(project);
  },
};
