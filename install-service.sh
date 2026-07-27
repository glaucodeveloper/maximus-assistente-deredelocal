#!/bin/bash
# Script de instalação do serviço systemd para a Central de Engenharia

# Cores para output
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}[Engenharia] Iniciando instalação do serviço de inicialização (systemd)...${NC}"

SERVICE_FILE="/home/icarogdo/dev/engenharia/engenharia.service"
TARGET_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
TARGET_FILE="$TARGET_DIR/engenharia.service"
ENGINEERING_PORT="${ENGINEERING_PORT:-3001}"
ENGINEERING_FTP_PORT="${ENGINEERING_FTP_PORT:-2122}"

if [ ! -f "$SERVICE_FILE" ]; then
  echo -e "${RED}[Erro] Arquivo engenharia.service não encontrado em /home/icarogdo/dev/engenharia/${NC}"
  exit 1
fi

mkdir -p "$TARGET_DIR"
echo -e "${GREEN}[Engenharia] Instalando serviço no escopo do usuário...${NC}"
sed -e "s/^Environment=PORT=.*/Environment=PORT=$ENGINEERING_PORT/" \
    -e "s/^Environment=FTP_PORT=.*/Environment=FTP_PORT=$ENGINEERING_FTP_PORT/" \
    "$SERVICE_FILE" > "$TARGET_FILE"

echo -e "${GREEN}[Engenharia] Recarregando o daemon do systemd do usuário...${NC}"
systemctl --user daemon-reload

echo -e "${GREEN}[Engenharia] Habilitando llama-server e Engenharia no login...${NC}"
systemctl --user enable llama-server.service engenharia.service

if command -v loginctl >/dev/null 2>&1; then
  echo -e "${GREEN}[Engenharia] Habilitando o user manager no boot (linger)...${NC}"
  loginctl enable-linger "$(id -un)" || echo -e "${RED}[Aviso] Não foi possível habilitar linger; o serviço iniciará no login.${NC}"
fi

echo -e "${GREEN}[Engenharia] Reiniciando o llama-server e a Engenharia agora...${NC}"
systemctl --user restart engenharia.service

echo -e "${GREEN}[Engenharia] Serviço instalado e iniciado com sucesso! Status atual:${NC}"
systemctl --user status engenharia.service --no-pager
