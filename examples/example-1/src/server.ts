import 'dotenv/config';
import express from 'express';
import { sharding } from './config/sharding.js';
import { userRoutes } from './routes/user.routes.js';
import { projectRoutes } from './routes/project.routes.js';

const app = express();

app.use(express.json());

app.use('/users', userRoutes);
app.use('/projects', projectRoutes);

await sharding.connect();

const server = app.listen(process.env.PORT || 3000);

const shutdown = async () => {
  server.close();
  await sharding.disconnect();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
