import { Router } from 'express';
import { UserController } from '../controllers/user.controller.js';

export const userRoutes = Router();

userRoutes.post('/', UserController.create);
userRoutes.get('/:id', UserController.getById);
