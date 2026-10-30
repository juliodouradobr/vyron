#!/usr/bin/env sh
# Backup do VYRON: banco de dados + arquivos enviados. Rode na pasta deploy/ (ex.: todo dia pelo cron).
#   ./backup.sh            → cria backups/vyron-AAAAMMDD-HHMM.sql.gz e .files.tar.gz
# Guarde cópias FORA deste servidor (outro computador ou armazenamento externo).
set -eu
cd "$(dirname "$0")"
mkdir -p backups
stamp=$(date +%Y%m%d-%H%M)

docker compose exec -T postgres pg_dump -U vyron -d vyron --no-owner | gzip > "backups/vyron-$stamp.sql.gz"
docker run --rm -v vyron_files:/data:ro -v "$(pwd)/backups:/out" alpine \
  tar czf "/out/vyron-$stamp.files.tar.gz" -C /data .

# Mantém os 14 backups mais recentes de cada tipo.
ls -1t backups/vyron-*.sql.gz 2>/dev/null | tail -n +15 | xargs -r rm --
ls -1t backups/vyron-*.files.tar.gz 2>/dev/null | tail -n +15 | xargs -r rm --
echo "backup criado: backups/vyron-$stamp.*"
