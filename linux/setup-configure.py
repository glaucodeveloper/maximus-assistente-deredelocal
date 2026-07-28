#!/usr/bin/env python3

from __future__ import annotations

import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Variável obrigatória ausente: {name}")
    return value


state_path = pathlib.Path(required("STATE_PATH"))
log_path = pathlib.Path(required("SETUP_LOG_PATH"))
main_config_path = pathlib.Path(required("MAIN_CONFIG_PATH"))
secret_path = pathlib.Path(required("SECRET_PATH"))
project_dir = pathlib.Path(required("PROJECT_DIR"))
public_dir = pathlib.Path(required("PUBLIC_DIR"))
litert_dir = pathlib.Path(required("LITERT_DIR"))
litert_bin = required("LITERT_BIN")
litert_url = required("LITERT_URL")
model_repository = required("MODEL_REPOSITORY")
model_file = required("MODEL_FILE")
model_alias = required("MODEL_ALIAS")
machine_id = required("MACHINE_ID")
machine_mac = required("MACHINE_MAC")
repository_name = required("REPOSITORY_NAME")
github_pat = required("GITHUB_PAT")
hf_token = required("HF_TOKEN")

log_path.parent.mkdir(parents=True, exist_ok=True)
log_stream = log_path.open("a", encoding="utf-8", buffering=1)
sys.stdout = log_stream
sys.stderr = log_stream

os.environ.pop("GITHUB_PAT", None)
os.environ.pop("HF_TOKEN", None)


def write_state(
    phase: str,
    progress: int,
    message: str,
    *,
    error: str = "",
    repository: str = "",
) -> None:
    state_path.parent.mkdir(parents=True, exist_ok=True)

    payload = {
        "runtime": "setup-nim",
        "setupRequired": True,
        "phase": phase,
        "progress": progress,
        "message": message,
        "error": error,
        "machineId": machine_id,
        "repositoryName": repository_name,
        "repository": repository,
        "updatedAt": datetime.now(timezone.utc).isoformat(),
    }

    temporary = state_path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    temporary.replace(state_path)


def github_request(
    method: str,
    url: str,
    payload: dict | None = None,
) -> tuple[int, dict]:
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {github_pat}",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "engenharia-interface-setup/3.2",
    }

    data = (
        json.dumps(payload).encode("utf-8")
        if payload is not None
        else None
    )

    request = urllib.request.Request(
        url,
        data=data,
        headers=headers,
        method=method,
    )

    try:
        with urllib.request.urlopen(
            request,
            timeout=60,
        ) as response:
            raw = response.read().decode("utf-8")
            return (
                response.status,
                json.loads(raw) if raw else {},
            )
    except urllib.error.HTTPError as error:
        raw = error.read().decode(
            "utf-8",
            errors="replace",
        )

        try:
            details = json.loads(raw)
        except json.JSONDecodeError:
            details = {"message": raw}

        return error.code, details


def put_repo_file(
    repository_url: str,
    path: str,
    content: str,
    message: str,
) -> None:
    encoded_path = "/".join(
        urllib.parse.quote(part, safe="")
        for part in path.split("/")
    )
    url = f"{repository_url}/contents/{encoded_path}"

    status, current = github_request("GET", url)

    body = {
        "message": message,
        "content": base64.b64encode(
            content.encode("utf-8")
        ).decode("ascii"),
        "branch": "main",
    }

    if status == 200:
        body["sha"] = current["sha"]
    elif status != 404:
        raise RuntimeError(
            f"Falha ao consultar {path}: HTTP {status}: "
            f"{current.get('message', current)}"
        )

    status, saved = github_request(
        "PUT",
        url,
        body,
    )

    if status not in (200, 201):
        raise RuntimeError(
            f"Falha ao gravar {path}: HTTP {status}: "
            f"{saved.get('message', saved)}"
        )


def encrypt_pat() -> None:
    secret_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    with tempfile.NamedTemporaryFile(
        dir=secret_path.parent,
        prefix="github-pat-",
        suffix=".cred",
        delete=False,
    ) as temporary:
        temporary_path = pathlib.Path(temporary.name)

    try:
        result = subprocess.run(
            [
                "systemd-creds",
                "encrypt",
                "--user",
                "--name=github-pat",
                "-",
                str(temporary_path),
            ],
            input=github_pat.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )

        if result.returncode != 0:
            raise RuntimeError(
                "systemd-creds recusou a proteção do PAT: "
                + result.stderr.decode(
                    "utf-8",
                    errors="replace",
                ).strip()
            )

        temporary_path.chmod(0o600)
        temporary_path.replace(secret_path)
    finally:
        temporary_path.unlink(missing_ok=True)


def wait_litert(timeout_seconds: int = 240) -> None:
    deadline = time.monotonic() + timeout_seconds
    endpoint = f"{litert_url}/v1/models"

    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                endpoint,
                timeout=5,
            ) as response:
                if response.status == 200:
                    return
        except Exception:
            pass

        time.sleep(2)

    raise RuntimeError(
        "LiteRT-LM não respondeu em /v1/models."
    )


try:
    log_path.write_text("", encoding="utf-8")

    write_state(
        "validating_github",
        8,
        "Validando o Personal Access Token do GitHub...",
    )

    status, user = github_request(
        "GET",
        "https://api.github.com/user",
    )

    if status != 200:
        raise RuntimeError(
            f"GitHub recusou o PAT: HTTP {status}: "
            f"{user.get('message', user)}"
        )

    owner = user["login"]
    display_name = user.get("name") or owner
    repository_url = (
        f"https://api.github.com/repos/"
        f"{owner}/{repository_name}"
    )

    write_state(
        "creating_repository",
        18,
        f"Preparando {owner}/{repository_name}...",
        repository=f"{owner}/{repository_name}",
    )

    status, repository = github_request(
        "GET",
        repository_url,
    )

    if status == 404:
        status, repository = github_request(
            "POST",
            "https://api.github.com/user/repos",
            {
                "name": repository_name,
                "description":
                    "Dados privados da aplicação Engenharia",
                "private": True,
                "auto_init": True,
            },
        )

        if status != 201:
            raise RuntimeError(
                "Não foi possível criar o repositório: "
                f"HTTP {status}: "
                f"{repository.get('message', repository)}"
            )

        time.sleep(2)
    elif status != 200:
        raise RuntimeError(
            "Não foi possível consultar o repositório: "
            f"HTTP {status}: "
            f"{repository.get('message', repository)}"
        )

    if not repository.get("private", False):
        raise RuntimeError(
            f"{owner}/{repository_name} precisa ser privado."
        )

    put_repo_file(
        repository_url,
        "documents/README.md",
        "# Engenharia Data\n\n"
        "Repositório privado usado pelo servidor Nim.\n",
        "Inicializar documentos de Engenharia",
    )

    put_repo_file(
        repository_url,
        "state/tasks.json",
        "[]\n",
        "Inicializar atividades de Engenharia",
    )

    machine_record = (
        json.dumps(
            {
                "machineId": machine_id,
                "macHash": machine_id,
                "host": os.uname().nodename,
                "registeredAt":
                    datetime.now(timezone.utc).isoformat(),
                "application": "Engenharia",
                "rawMacStored": False,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n"
    )

    put_repo_file(
        repository_url,
        f"machines/{machine_id}.json",
        machine_record,
        "Registrar servidor local de Engenharia",
    )

    write_state(
        "protecting_credential",
        30,
        "Criptografando o PAT para esta máquina...",
        repository=f"{owner}/{repository_name}",
    )

    encrypt_pat()

    main_config_path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    main_config = {
        "port": 3001,
        "publicDir": str(public_dir),
        "secretPath": str(secret_path),
        "githubOwner": owner,
        "githubRepo": repository_name,
        "githubBranch": "main",
        "macHash": machine_id,
        "litertBaseUrl": litert_url,
        "modelAlias": model_alias,
        "displayName": display_name,
    }

    main_config_path.write_text(
        json.dumps(
            main_config,
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    main_config_path.chmod(0o600)

    model_path = (
        litert_dir
        / "models"
        / model_alias
        / "model.litertlm"
    )

    if (
        not model_path.exists()
        or model_path.stat().st_size < 1_000_000_000
    ):
        write_state(
            "downloading_model",
            45,
            "Baixando e importando Gemma 4 E2B...",
            repository=f"{owner}/{repository_name}",
        )

        child_env = os.environ.copy()
        child_env["HF_TOKEN"] = hf_token
        child_env["LITERT_LM_DIR"] = str(litert_dir)

        completed = subprocess.run(
            [
                litert_bin,
                "import",
                f"--from-huggingface-repo={model_repository}",
                model_file,
                model_alias,
            ],
            env=child_env,
            cwd=project_dir,
            check=False,
        )

        child_env.pop("HF_TOKEN", None)

        if completed.returncode != 0:
            raise RuntimeError(
                "A importação do Gemma 4 E2B falhou. "
                "Consulte o registro exibido na interface."
            )

    if not model_path.exists():
        raise RuntimeError(
            "O arquivo importado do Gemma 4 não foi localizado."
        )

    write_state(
        "starting_litert",
        88,
        "Iniciando o servidor LiteRT-LM...",
        repository=f"{owner}/{repository_name}",
    )

    subprocess.run(
        [
            "systemctl",
            "--user",
            "enable",
            "--now",
            "engenharia-litert.service",
        ],
        check=True,
    )

    wait_litert()

    write_state(
        "ready",
        100,
        "Credenciais protegidas, repositório pronto e Gemma 4 ativo.",
        repository=f"{owner}/{repository_name}",
    )

except Exception as error:
    print(f"ERRO: {error}", flush=True)

    write_state(
        "error",
        0,
        "A configuração foi interrompida.",
        error=str(error),
    )

    raise
finally:
    github_pat = ""
    hf_token = ""
