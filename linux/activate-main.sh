#!/usr/bin/env bash
set -Eeuo pipefail

sleep 2

systemctl --user enable --now engenharia-litert.service

for _ in $(seq 1 90); do
  if curl -fsS \
    --max-time 3 \
    http://127.0.0.1:9379/v1/models \
    >/dev/null 2>&1
  then
    break
  fi

  sleep 2
done

systemctl --user disable --now engenharia-bootstrap.service || true
sleep 1
systemctl --user enable --now engenharia-nim.service
