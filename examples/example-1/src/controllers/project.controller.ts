import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { sharding } from '../config/sharding.js';

export const ProjectController = {
  async create(req: Request, res: Response) {
    const db = await sharding.resolveShard(req.body.userId);

    const project = await db.project.create({
      data: {
        id: randomUUID(),
        name: req.body.name,
        userId: req.body.userId
      }
    });

    res.status(201).json(project);
  },

  async getById(req: Request, res: Response) {
    const found = await sharding.findAcrossShards((db) =>
      db.project.findUnique({
        where: { id: req.params.id }
      })
    );

    res.json(found.data);
  }
};
