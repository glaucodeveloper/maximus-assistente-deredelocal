# Pareamento de dispositivos

A autenticação combina:

1. token de acesso aleatório;
2. endereço físico observado pelo servidor;
3. registro ativo do dispositivo no SQLite.

O servidor armazena somente SHA-256 dos tokens. O token bruto permanece no
navegador ou no cliente FTPS. Copiar o token para outra máquina não autoriza o
acesso porque o endereço físico observado precisa corresponder ao registro.

## Primeiro dispositivo

```bash
npm run pairing:issue -- --hours 24
```

Abra a aplicação, informe o token uma única vez e conclua o cadastro.

## Máquina perdida ou substituída

```bash
npm run devices:list
npm run device:revoke -- DEV-...
npm run pairing:issue -- --user USR-... --hours 24
```

O token de recuperação é vinculado ao usuário existente. O novo dispositivo
recebe outro token de acesso, e o dispositivo revogado deixa de autenticar.

## Limites

O endereço MAC é observável apenas no mesmo segmento de rede local. NAT, VPN,
proxy e redes roteadas podem ocultá-lo. MAC pode ser falsificado por alguém com
controle administrativo da máquina e da rede. Para ambientes hostis, substitua
o vínculo por certificado de cliente, WebAuthn ou chave pública por dispositivo.

HTTPS e FTPS são obrigatórios porque um token transmitido em texto claro pode
ser capturado na rede.
