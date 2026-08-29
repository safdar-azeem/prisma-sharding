# Prisma Sharding + Express Simple Example

A deliberately small example showing only:

- Express
- TypeScript
- Prisma
- PostgreSQL shards
- `prisma-sharding`
- User and Project models
- Simple MVC folders

## Structure

```text
src/
  config/
    sharding.ts
  controllers/
    user.controller.ts
    project.controller.ts
  routes/
    user.routes.ts
    project.routes.ts
  server.ts

prisma/
  schema.prisma
  migrations/
```

## Sharding flow

### Signup

The client does not need to already know a user ID.

The server creates the ID first:

```ts
const id = randomUUID();
const db = await sharding.allocateShard(id);
```

Then the user is created on that shard.

```text
POST /users
{
  "name": "Safdar",
  "email": "safdar@example.com"
}
```

### Get user

Only one ID is used:

```text
GET /users/:id
```

```ts
const db = await sharding.resolveShard(req.params.id);
```

### Create project

A project belongs to a user, so it is created on the same shard as that user.

```text
POST /projects
{
  "name": "My Project",
  "userId": "USER_ID"
}
```

```ts
const db = await sharding.resolveShard(req.body.userId);
```

### Get project

The route still needs only the project ID:

```text
GET /projects/:id
```

Because this tiny example does not store a project-to-shard lookup separately, it demonstrates:

```ts
sharding.findAcrossShards(...)
```

for that lookup.

## Database

Create the normal Prisma migration, then let `prisma-sharding` apply it to the configured shards:

```bash
yarn db:generate
yarn db:update
```

## Start

```bash
cp .env.example .env
yarn
yarn db:generate
yarn db:update
yarn dev
```
