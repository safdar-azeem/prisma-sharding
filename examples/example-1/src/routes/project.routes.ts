import { Router } from 'express';
import { ProjectController } from '../controllers/project.controller.js';

export const projectRoutes = Router();

projectRoutes.post('/', ProjectController.create);
projectRoutes.get('/:id', ProjectController.getById);
