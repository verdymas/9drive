# Runbook: Prisma Database Migration

## Development

```bash
cd backend
npm run prisma:migrate
```

After schema/client changes:

```bash
npm run prisma:generate
```

## Deployment

```bash
cd backend
npm run db:migrate:deploy
```

`start:deploy` and the Docker worker flow also run deployment migrations before process startup.

## Checklist

1. Review the `backend/prisma/schema.prisma` diff.
2. Review generated migration SQL, especially destructive column/index changes.
3. Run backend tests that touch the changed models.
4. For status/string-vocabulary changes, search usages in frontend, backend, and tests because these fields are not always Prisma enums.
5. Back up production data before destructive migrations.
