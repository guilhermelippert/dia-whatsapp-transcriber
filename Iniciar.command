#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Instale o Node.js 22 ou superior e abra novamente. Se já usa Node no terminal, execute npm run setup e npm start por lá."
  exit 1
fi
exec node scripts/setup.mjs --start
