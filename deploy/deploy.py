#!/usr/bin/env python3
"""Publication d'une nouvelle version de l'application (Reflect FiveM).

    python deploy/deploy.py                  build, signature, envoi et publication (production)
    python deploy/deploy.py --no-build       publie les fichiers déjà présents dans release/ (build fait ailleurs)
    python deploy/deploy.py --draft          envoie sans publier (à vérifier puis publier dans l'administration)
    python deploy/deploy.py --notes-file notes.md   nouveautés affichées sur le site et dans l'application
    python deploy/deploy.py --dev            API de dev (http://192.168.1.13:8080/api) au lieu de la production
    python deploy/deploy.py --check          vérifie clé, fichiers, API et connexion, sans rien modifier

Étapes :
  1. npm run dist : installateur release/Reflect-FiveM-Setup-X.Y.Z.exe et version portable ;
  2. signature de chaque fichier avec la clé de publication (scripts/sign-release.mjs, clé privée locale) ;
  3. API : connexion au compte d'administration, création de la version X.Y.Z (numéro de package.json),
     envoi des fichiers en morceaux (reprise après coupure), signatures, publication ;
  4. vérification : latest.yml annonce la nouvelle version aux applications installées.

Configuration (partagée avec le site et l'API) : variables d'environnement, sinon deploy/deploy.env, sinon
../deploy.env (dossier PackInstaller). Clés : PACKS_ADMIN_USER, PACKS_ADMIN_PASSWORD (et PACKS_DEV_ADMIN_USER,
PACKS_DEV_ADMIN_PASSWORD pour --dev). Modèle : deploy/deploy.env.example. Le mot de passe n'est jamais affiché.

L'installateur NSIS ne peut pas être construit sur un poste où Smart App Control bloque electron-builder :
construire ailleurs (ou avec un certificat de signature de code), copier les .exe dans release/ puis --no-build.

Dépendance : python -m pip install -r deploy/requirements.txt (requests).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

try:
    import requests
except ImportError:
    sys.stderr.write("Module requests manquant : python -m pip install -r deploy/requirements.txt\n")
    sys.exit(2)

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
WORKSPACE_DIR = PROJECT_DIR.parent
RELEASE_DIR = PROJECT_DIR / "release"
SIGN_SCRIPT = PROJECT_DIR / "scripts" / "sign-release.mjs"

API_URLS = {"prod": "https://reflect-fivem.com/api", "dev": "http://192.168.1.13:8080/api"}
SITE_URLS = {"prod": "https://reflect-fivem.com", "dev": "http://192.168.1.13:5173"}
CONFIG_FILES = [SCRIPT_DIR / "deploy.env", WORKSPACE_DIR / "deploy.env"]
CHUNK_SIZES = [8, 4, 2, 1, 0.5, 0.25]
SEMVER = re.compile(r"^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$")


# ----------------------------------------------------------------------------------------------------------
# Affichage

if os.name == "nt":
    os.system("")
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass


class DeployError(Exception):
    """Erreur déjà expliquée : le script s'arrête avec le code 1."""


def step(message: str) -> None:
    print(f"\n\033[1;36m==> {message}\033[0m", flush=True)


def info(message: str) -> None:
    print(f"    {message}", flush=True)


def ok(message: str) -> None:
    print(f"    \033[32mOK\033[0m {message}", flush=True)


def warn(message: str) -> None:
    print(f"    \033[33mATTENTION\033[0m {message}", flush=True)


def fail(message: str) -> DeployError:
    print(f"    \033[31mERREUR\033[0m {message}", file=sys.stderr, flush=True)
    return DeployError(message)


def human(size: float) -> str:
    for unit in ("o", "Ko", "Mo", "Go"):
        if size < 1024 or unit == "Go":
            return f"{size:.0f} {unit}" if unit == "o" else f"{size:.1f} {unit}".replace(".", ",")
        size /= 1024
    return f"{size} o"


# ----------------------------------------------------------------------------------------------------------
# Configuration

def parse_env_file(path: Path) -> dict[str, str]:
    """CLE=valeur par ligne ; valeur entre guillemets prise telle quelle (caractères spéciaux compris)."""
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        else:
            value = value.split(" #", 1)[0].strip()
        values[key] = value
    return values


class Config:
    def __init__(self, env: str) -> None:
        file_values: dict[str, str] = {}
        self.source = "variables d'environnement"
        for candidate in CONFIG_FILES:
            if candidate.is_file():
                file_values = parse_env_file(candidate)
                self.source = str(candidate)
                break
        prefix = "PACKS_DEV_ADMIN_" if env == "dev" else "PACKS_ADMIN_"

        def get(name: str, default: str = "") -> str:
            return os.environ.get(name) or file_values.get(name) or default

        self.env = env
        self.api = get("PACKS_DEV_API_URL" if env == "dev" else "PACKS_API_URL", API_URLS[env]).rstrip("/")
        self.site = SITE_URLS[env]
        self.user = get(prefix + "USER", "admin")
        self.password = get(prefix + "PASSWORD")

    def require_password(self) -> None:
        if not self.password:
            name = "PACKS_DEV_ADMIN_PASSWORD" if self.env == "dev" else "PACKS_ADMIN_PASSWORD"
            info(f"Fichiers lus : {', '.join(str(p) for p in CONFIG_FILES)}")
            raise fail(f"{name} manquant : mot de passe du compte d'administration du site (voir deploy/deploy.env.example)")


# ----------------------------------------------------------------------------------------------------------
# API

class Api:
    """Connexion comme le site : POST /auth/login {login, password} renvoie un jeton d'accès (15 minutes), envoyé dans
    l'en-tête Authorization: Bearer ; le jeton de renouvellement reste dans le cookie PACKS_REFRESH de la session HTTP.
    Jeton d'accès refusé pendant un long envoi (401 « token-invalid ») : renouvelé, puis la requête est rejouée."""

    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.http = requests.Session()
        self.http.headers["User-Agent"] = "reflect-fivem-deploy"
        self.access_token: str | None = None

    def _send(self, method: str, path: str, **kwargs) -> requests.Response:
        """Requête connectée, rejouée une fois après renouvellement du jeton d'accès. Lève requests.RequestException."""
        headers = kwargs.pop("headers", {})
        for attempt in range(2):
            auth = {"Authorization": f"Bearer {self.access_token}"} if self.access_token else {}
            response = self.http.request(method, self.cfg.api + path, headers={**headers, **auth}, **kwargs)
            if attempt or not self.access_token or response.status_code != 401 or safe_json(response).get("code") != "token-invalid":
                return response
            self._renew()
        return response

    def request(self, method: str, path: str, check: bool = True, **kwargs) -> requests.Response:
        try:
            response = self._send(method, path, timeout=kwargs.pop("timeout", 60), **kwargs)
        except requests.RequestException as exc:
            raise fail(f"API injoignable ({self.cfg.api}) : {exc.__class__.__name__}")
        if check and not response.ok:
            raise fail(f"{method} {path} : {problem(response)}")
        return response

    def _open(self) -> dict:
        try:
            response = self.http.post(f"{self.cfg.api}/auth/login", json={"login": self.cfg.user, "password": self.cfg.password}, timeout=60)
        except requests.RequestException as exc:
            raise fail(f"API injoignable ({self.cfg.api}) : {exc.__class__.__name__}")
        body = safe_json(response)
        if response.status_code != 200 or not body.get("accessToken"):
            raise fail(f"connexion au compte « {self.cfg.user} » refusée : {problem(response)}")
        self.access_token = body["accessToken"]
        return body

    def _renew(self) -> None:
        """Nouveau jeton d'accès par le cookie de renouvellement, sinon nouvelle connexion."""
        try:
            response = self.http.post(f"{self.cfg.api}/auth/refresh", timeout=60)
            if response.ok and safe_json(response).get("accessToken"):
                self.access_token = safe_json(response)["accessToken"]
                return
        except requests.RequestException:
            pass
        self._open()

    def login(self) -> None:
        self.cfg.require_password()
        body = self._open()
        if (body.get("me") or {}).get("mustChangePassword"):
            raise fail(f"le mot de passe initial doit d'abord être changé sur {self.cfg.site}/admin, puis renseigné dans deploy.env")
        ok(f"connecté à {self.cfg.api} ({self.cfg.user})")

    def logout(self) -> None:
        try:
            self.http.post(f"{self.cfg.api}/auth/logout", timeout=15)
        except requests.RequestException:
            pass
        self.access_token = None

    def upload(self, release_id: str, kind: str, path: Path) -> None:
        """Envoi en morceaux : reprise à la bonne position (409), morceaux plus petits si un proxy refuse. Un envoi
        interrompu (script arrêté, coupure) reprend au lancement suivant si le fichier n'a pas changé."""
        size = path.stat().st_size
        resume_key = f"{self.cfg.api}|{release_id}|{kind}|{path.resolve()}|{size}|{path.stat().st_mtime_ns}"
        resumes = load_resumes()
        state = None
        if resume_key in resumes:
            previous = self.request("GET", f"/admin/uploads/{resumes[resume_key]}", check=False)
            if previous.ok and previous.json().get("status") == "uploading":
                state = previous.json()
                info(f"reprise de l'envoi de {path.name} à {human(state['received'])}")
        if state is None:
            state = self.request("POST", "/admin/uploads", json={
                "purpose": "release-file", "targetId": release_id, "kind": kind, "fileName": path.name, "size": size}).json()
            resumes[resume_key] = state["id"]
            save_resumes(resumes)
        upload_id = state["id"]
        offset = state["received"]
        size_index = 0
        failures = 0
        started = time.monotonic()
        with path.open("rb") as handle:
            while offset < size:
                chunk_size = min(int(CHUNK_SIZES[size_index] * 1024 * 1024), state.get("maxChunk", 16 * 1024 * 1024))
                handle.seek(offset)
                data = handle.read(chunk_size)
                try:
                    response = self._send("PUT", f"/admin/uploads/{upload_id}", params={"offset": offset}, data=data,
                                          headers={"Content-Type": "application/octet-stream"}, timeout=300)
                except requests.RequestException:
                    response = None
                if response is not None and response.ok:
                    offset = response.json()["received"]
                    failures = 0
                    speed = offset / max(time.monotonic() - started, 0.001)
                    print(f"\r    {path.name} : {offset * 100 // size} % ({human(offset)} sur {human(size)}, {human(speed)}/s)   ",
                          end="", flush=True)
                    continue
                if response is not None and response.status_code == 409 and "received" in safe_json(response):
                    offset = safe_json(response)["received"]
                    continue
                failures += 1
                if failures > 8:
                    print()
                    raise fail(f"envoi de {path.name} interrompu : {problem(response) if response is not None else 'connexion impossible'}")
                if response is None or response.status_code in (413, 502, 503, 504):
                    if failures % 2 == 0 and size_index < len(CHUNK_SIZES) - 1:
                        size_index += 1
                    time.sleep(min(2 * failures, 10))
                    continue
                print()
                raise fail(f"envoi de {path.name} refusé : {problem(response)}")
        print()
        self.request("POST", f"/admin/uploads/{upload_id}/complete")
        while True:
            state = self.request("GET", f"/admin/uploads/{upload_id}").json()
            if state["status"] == "done":
                break
            if state["status"] == "failed":
                forget_resume(resume_key)
                raise fail(f"{path.name} refusé par le serveur : {state.get('error')}")
            time.sleep(1)
        forget_resume(resume_key)
        ok(f"{path.name} envoyé ({human(size)})")


RESUME_FILE = SCRIPT_DIR / ".uploads.json"


def load_resumes() -> dict[str, str]:
    try:
        return json.loads(RESUME_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_resumes(resumes: dict[str, str]) -> None:
    if resumes:
        RESUME_FILE.write_text(json.dumps(resumes, indent=1), encoding="utf-8")
    else:
        RESUME_FILE.unlink(missing_ok=True)


def forget_resume(key: str) -> None:
    resumes = load_resumes()
    if resumes.pop(key, None) is not None:
        save_resumes(resumes)


def safe_json(response: requests.Response) -> dict:
    try:
        return response.json()
    except ValueError:
        return {}


def problem(response: requests.Response) -> str:
    detail = safe_json(response).get("detail")
    return f"HTTP {response.status_code}" + (f", {detail}" if detail else "")


# ----------------------------------------------------------------------------------------------------------
# Build et signature

def package_version() -> str:
    return json.loads((PROJECT_DIR / "package.json").read_text(encoding="utf-8"))["version"]


def npm() -> str:
    found = shutil.which("npm.cmd" if os.name == "nt" else "npm") or shutil.which("npm")
    if not found:
        raise fail("npm introuvable (installez Node.js)")
    return found


def build() -> None:
    step("Build de l'application (npm run dist)")
    if subprocess.run([npm(), "run", "dist"], cwd=PROJECT_DIR).returncode != 0:
        raise fail("build en échec. Si electron-builder s'arrête sur « spawn UNKNOWN », Smart App Control bloque la "
                   "création de l'installateur sur ce poste : construisez ailleurs, copiez les .exe dans release/ "
                   "puis relancez avec --no-build")


def release_files(version: str, setup: str | None, portable: str | None) -> dict[str, Path]:
    files: dict[str, Path] = {}
    candidates = {
        "setup": Path(setup) if setup else RELEASE_DIR / f"Reflect-FiveM-Setup-{version}.exe",
        "portable": Path(portable) if portable else RELEASE_DIR / f"Reflect-FiveM-Portable-{version}.exe",
    }
    for kind, path in candidates.items():
        if path.is_file():
            files[kind] = path
            ok(f"{'installateur' if kind == 'setup' else 'version portable'} : {path.name} ({human(path.stat().st_size)})")
        elif kind == "setup":
            raise fail(f"installateur introuvable : {path} (les mises à jour automatiques en ont besoin)")
        else:
            warn(f"version portable introuvable ({path.name}) : seul l'installateur sera publié")
    return files


def sign(path: Path, version: str) -> str:
    """Signature Ed25519 par scripts/sign-release.mjs (qui vérifie aussi que la clé est celle de l'application)."""
    node = shutil.which("node")
    if not node:
        raise fail("node introuvable")
    result = subprocess.run([node, str(SIGN_SCRIPT), str(path), "--version", version], cwd=PROJECT_DIR,
                            capture_output=True, text=True, encoding="utf-8")
    Path(f"{path}.sig").unlink(missing_ok=True)
    match = re.search(r"^Signature : (\S+)$", result.stdout, re.M)
    if result.returncode != 0 or not match:
        raise fail(f"signature de {path.name} impossible : {(result.stderr or result.stdout).strip()}")
    return match.group(1)


def read_notes(args: argparse.Namespace) -> str | None:
    if args.notes_file:
        return Path(args.notes_file).read_text(encoding="utf-8-sig").strip()
    if args.notes is not None:
        return args.notes.strip()
    return None


# ----------------------------------------------------------------------------------------------------------
# Modes

def publish(cfg: Config, args: argparse.Namespace) -> None:
    started = time.monotonic()
    version = args.version or package_version()
    if not SEMVER.match(version):
        raise fail(f"numéro de version invalide : {version}")
    notes = read_notes(args)
    step(f"Version {version} vers {cfg.api}{' (brouillon)' if args.draft else ''}")
    cfg.require_password()

    if not args.no_build:
        build()

    step("Fichiers de la version")
    files = release_files(version, args.setup, args.portable)

    step("Signature (clé de publication locale)")
    signatures = {kind: sign(path, version) for kind, path in files.items()}
    for kind in files:
        ok(f"{files[kind].name} signé")

    step("Envoi")
    api = Api(cfg)
    api.login()
    try:
        existing = next((r for r in api.request("GET", "/admin/releases").json() if r["version"] == version), None)
        if existing and existing["published"]:
            raise fail(f"la version {version} est déjà publiée : montez le numéro dans package.json")
        if existing:
            release = existing
            info(f"version {version} déjà créée (non publiée) : ses fichiers sont remplacés")
            if notes is not None:
                release = api.request("PUT", f"/admin/releases/{release['id']}/notes", json={"notes": notes}).json()
        else:
            release = api.request("POST", "/admin/releases", json={"version": version, "notes": notes or ""}).json()
            ok(f"version {version} créée")
        for kind, path in files.items():
            api.upload(release["id"], kind, path)
            release = api.request("PUT", f"/admin/releases/{release['id']}/files/{kind}/signature",
                                  json={"signature": signatures[kind]}).json()
            ok(f"signature de {path.name} acceptée par le serveur")

        if args.draft:
            step(f"Version {version} envoyée sans être publiée")
            info(f"à publier dans {cfg.site}/admin/versions")
            return
        api.request("PUT", f"/admin/releases/{release['id']}/published", json={"published": True})
        ok(f"version {version} publiée")
    finally:
        api.logout()

    step("Vérification")
    latest = requests.get(f"{cfg.api}/app/updates/latest.yml", timeout=30)
    announced = re.search(r"^version: (\S+)$", latest.text, re.M)
    if latest.ok and announced and announced.group(1) == version:
        ok(f"latest.yml annonce la version {version} aux applications installées")
    else:
        warn(f"latest.yml annonce {announced.group(1) if announced else '?'} (une version plus récente est-elle déjà publiée ?)")
    step(f"Version {version} publiée en {time.monotonic() - started:.0f} s")
    info(f"page de téléchargement : {cfg.site}/application")


def check(cfg: Config, args: argparse.Namespace) -> None:
    version = args.version or package_version()
    step("Configuration locale")
    info(f"configuration : {cfg.source}")
    info(f"API           : {cfg.api}")
    info(f"compte        : {cfg.user} ({'mot de passe renseigné' if cfg.password else 'MOT DE PASSE MANQUANT'})")
    info(f"version       : {version} ({'--version' if args.version else 'package.json'})")
    step("Fichiers de la version")
    try:
        files = release_files(version, args.setup, args.portable)
        step("Signature (test, rien n'est envoyé)")
        sign(files["setup"], version)
        ok("clé de publication présente et identique à celle de l'application")
    except DeployError:
        info("build nécessaire (npm run dist) ou fichiers à copier dans release/")
    step(f"API {cfg.api} (lecture seule)")
    health = requests.get(f"{cfg.api}/actuator/health", timeout=15)
    ok(f"santé : {health.json().get('status')}") if health.ok else warn(f"santé : HTTP {health.status_code}")
    if not cfg.password:
        warn("connexion non testée : mot de passe manquant")
        return
    api = Api(cfg)
    api.login()
    try:
        existing = next((r for r in api.request("GET", "/admin/releases").json() if r["version"] == version), None)
        if existing is None:
            ok(f"version {version} pas encore créée : prête à être publiée")
        elif existing["published"]:
            warn(f"version {version} déjà publiée : montez le numéro dans package.json")
        else:
            info(f"version {version} créée mais non publiée : ses fichiers seront remplacés")
    finally:
        api.logout()


def main() -> int:
    parser = argparse.ArgumentParser(description="Publie une nouvelle version de Reflect FiveM.")
    parser.add_argument("--check", action="store_true", help="vérifie sans rien modifier")
    parser.add_argument("--dev", action="store_true", help="API de dev au lieu de la production")
    parser.add_argument("--no-build", action="store_true", help="utilise les fichiers déjà présents dans release/")
    parser.add_argument("--draft", action="store_true", help="envoie sans publier")
    parser.add_argument("--notes", help="nouveautés (Markdown)")
    parser.add_argument("--notes-file", help="fichier Markdown des nouveautés")
    parser.add_argument("--version", help="numéro de version (par défaut celui de package.json)")
    parser.add_argument("--setup", help="chemin de l'installateur (par défaut release/Reflect-FiveM-Setup-X.Y.Z.exe)")
    parser.add_argument("--portable", help="chemin de la version portable")
    args = parser.parse_args()
    try:
        cfg = Config("dev" if args.dev else "prod")
        if args.check:
            check(cfg, args)
        else:
            publish(cfg, args)
        return 0
    except DeployError:
        return 1
    except requests.RequestException as exc:
        print(f"    \033[31mERREUR\033[0m API injoignable : {exc.__class__.__name__}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\ninterrompu (un envoi reprend là où il s'était arrêté si vous relancez)", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
