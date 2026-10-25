$ErrorActionPreference = 'Stop'
$taskBackend = Split-Path $PSScriptRoot -Parent
Push-Location $taskBackend
try {
  $env:DATABASE_URL = 'mysql://root:chatforum-test-only@127.0.0.1:33316/chatforum_test'
  $env:QDRANT_URL = 'http://127.0.0.1:36336'
  $env:REDIS_HOST = '127.0.0.1'
  $env:REDIS_PORT = '36386'
  $env:REDIS_PASSWORD = ''
  $env:JWT_ACCESS_SECRET = 'integration-test-access-secret-at-least-32'
  $env:JWT_REFRESH_SECRET = 'integration-test-refresh-secret-at-least-32'
  $env:RUN_RAG_INTEGRATION = '1'
  & npx.cmd prisma generate
  if ($LASTEXITCODE -ne 0) { throw 'Prisma generate failed' }
  & npx.cmd prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Migrations failed' }
  & npm.cmd test -- --runInBand
  if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
} finally { Pop-Location }
