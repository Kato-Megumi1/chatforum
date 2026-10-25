#!/bin/sh
set -eu
echo "Applying reviewed database migrations..."
npx prisma migrate deploy
echo "Starting nginx and API..."
nginx
exec node dist/src/main.js
