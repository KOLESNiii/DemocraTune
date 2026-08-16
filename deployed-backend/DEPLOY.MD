# Recommendation backend deployment

This runbook deploys the independently hosted recommendation system in this
directory:

- FastAPI coordinator and leased SQLite extraction queue;
- single-node Qdrant vector database;
- Caddy public TLS endpoint;
- continuous ARM64 CPU extraction worker on Oracle Ampere;
- optional intermittent AMD64 home worker.

The main Vercel and Convex application has a separate runbook at
[`../DEPLOY.MD`](../DEPLOY.MD).

## Deployment modes

| Host                            | Services                                 | Compose profile |
| ------------------------------- | ---------------------------------------- | --------------- |
| Oracle Ampere A1                | `api`, `qdrant`, `caddy`, `worker-arm64` | `worker-arm64`  |
| Oracle AMD64 without extraction | `api`, `qdrant`, `caddy`                 | none            |
| Home Ubuntu AMD64 PC            | `worker` only                            | `worker`        |

The workers use CPU inference. No NVIDIA driver, CUDA runtime, or GPU is
required. The home RTX 2070 Super is not used by the supplied image.

## 1. Provision the Oracle host

Recommended starting point:

- Ubuntu ARM64 on an OCI Ampere A1 instance;
- 2 OCPUs and 12 GB RAM when available within the account's free allocation;
- enough boot/block volume capacity for Docker images, Qdrant data, snapshots,
  and growth;
- a static public IP and DNS record for the backend hostname.

The modern 1,280-dimensional collection is demand-created and must not be
pre-filled with the entire AcousticBrainz corpus. Keep the raw archive on the
home PC and monitor Oracle disk use as the online collection grows.

Install Docker Engine, Buildx, and the Compose plugin using Docker's official
Ubuntu repository. Verify them before continuing:

```bash
uname -m
docker version
docker buildx version
docker compose version
```

`uname -m` should report `aarch64` for the continuous ARM worker. The host also
needs outbound DNS, HTTPS, and container-registry access during builds and
normal worker operation.

### Network rules

Allow inbound traffic only for:

- SSH from trusted source addresses;
- TCP 80 for Caddy's HTTP-to-HTTPS flow and certificate issuance;
- TCP 443 for HTTPS;
- UDP 443 for HTTP/3.

Apply the rules in the OCI security list or network security group and in the
host firewall. Do not expose ports 6333, 6334, or 8000 publicly. Qdrant and
FastAPI are reachable only through the private Compose network; Caddy is the
public entry point.

Point the backend DNS record at the Oracle public IP before starting Caddy.

## 2. Install and configure the stack

Clone or update the repository on the Oracle host, then enter this directory:

```bash
cd DemocraTune/deployed-backend
cp .env.example .env
```

Generate three different secrets:

```bash
openssl rand -hex 32
openssl rand -hex 32
openssl rand -hex 32
```

Edit `.env` and replace every placeholder. Never commit this file.

| Variable                        | Required value                                                   |
| ------------------------------- | ---------------------------------------------------------------- |
| `BACKEND_ADDRESS`               | Public DNS hostname handled by Caddy, without a scheme.          |
| `APP_API_TOKEN`                 | Secret used only by the trusted application/Convex caller.       |
| `WORKER_API_TOKEN`              | Different secret shared with extraction workers.                 |
| `QDRANT_API_KEY`                | Different secret used only inside the backend stack.             |
| `DEFAULT_PIPELINE_VERSION`      | Keep `essentia-discogs-effnet-1280-v1` for the supplied workers. |
| `DEFAULT_SOURCE_ORDER`          | Ordered comma-separated fallback policy.                         |
| `ORACLE_WORKER_BACKEND_API_URL` | Keep `http://api:8000` when the worker is in this Compose stack. |
| `ARM_WORKER_ID`                 | Stable, recognizable name for this worker.                       |
| `ARM_WORKER_BUILD_JOBS`         | Start at `2`; affects compilation only.                          |
| `ARM_WORKER_CPUS`               | Start at `1.0`.                                                  |
| `ARM_WORKER_MEMORY`             | Start at `4g`.                                                   |

Do not reuse the app, worker, or Qdrant tokens. Store the app token as
`RECOMMENDATION_API_TOKEN` in the trusted Convex environment, with this
service's HTTPS origin as `RECOMMENDATION_API_URL`. Never place either value in
a browser bundle.

Validate interpolation before building:

```bash
docker compose --profile worker-arm64 config --quiet
```

For a source checkout intended for production, also run the backend tests,
syntax checks, and an ARM image build before changing the live services:

```bash
PYTHONPATH=. python -m unittest discover -s tests
python -m compileall app worker
docker buildx build --platform linux/arm64 \
  -f worker/Dockerfile.arm64 worker --load
```

## 3. Start the Oracle stack

On the ARM64 Oracle host:

```bash
docker compose --profile worker-arm64 up --build -d \
  api qdrant caddy worker-arm64
docker compose ps
docker compose logs --tail=100 api qdrant caddy worker-arm64
```

The first ARM worker build compiles a pinned Essentia revision against the
ARM64 TensorFlow CPU wheel. It can take several minutes; later builds reuse the
dependency and native compilation layers. The final image contains ffmpeg,
`yt-dlp`, Essentia, TensorFlow, the checksum-verified Discogs-EffNet model, and
the worker code.

To run only the always-available API without extraction:

```bash
docker compose up --build -d api qdrant caddy
```

## 4. Verify the deployment

Wait for Qdrant and FastAPI to become ready, then check locally and through
Caddy:

```bash
docker compose ps
docker compose logs --tail=100 api qdrant worker-arm64
docker compose exec api python -c 'import httpx; response = httpx.get("http://127.0.0.1:8000/health"); response.raise_for_status(); print(response.json())'
curl --fail https://your-backend.example.com/health
```

The health response should report both `ok` and `qdrant` as `true`.

Test authentication without exposing a token in the URL:

```bash
read -rsp 'APP_API_TOKEN: ' APP_API_TOKEN
printf '\n'
curl --fail \
  -H "Authorization: Bearer $APP_API_TOKEN" \
  "https://your-backend.example.com/v1/features/8a49dba0-253a-4535-b87f-78bb035336ce?pipeline_version=essentia-discogs-effnet-1280-v1"
unset APP_API_TOKEN
```

Run one controlled enqueue/recommendation test using the API examples in
[`README.md`](README.md), then confirm the ARM worker claims and completes the
job:

```bash
docker compose logs --follow worker-arm64
```

## 5. Deploy the optional home worker

The home worker is outbound-only. It needs HTTPS access to the Oracle backend
and normal outbound access for `yt-dlp`; it needs no inbound firewall port.

On the AMD64 Ubuntu PC, copy or clone this directory and create `.env` from the
example. Set:

- `BACKEND_API_URL=https://your-backend.example.com`;
- `WORKER_API_TOKEN` to the exact Oracle worker token;
- `WORKER_ID` to a unique stable name such as `home-ubuntu-worker`.

Compose validates variables from the whole file, so leave non-worker required
keys populated even though this host starts only the worker service.

```bash
cd DemocraTune/deployed-backend
docker compose --profile worker config --quiet
docker compose --profile worker up --build -d worker
docker compose logs --follow worker
```

It is safe to turn this PC off. A heartbeat keeps active work leased while the
worker runs; an interrupted lease becomes claimable again after
`WORKER_LEASE_SECONDS`. Temporary audio is held in a temporary directory and
removed after each attempt.

## Routine operations

### Status and logs

```bash
docker compose --profile worker-arm64 ps
docker compose logs --tail=200 api qdrant caddy worker-arm64
docker compose logs --follow api worker-arm64
docker system df
df -h
```

### Restart one service

```bash
docker compose restart api
docker compose restart worker-arm64
```

### Deploy an update

Review the incoming commit and back up state first. Then:

```bash
git pull --ff-only
cd deployed-backend
docker compose --profile worker-arm64 config --quiet
docker compose --profile worker-arm64 build api worker-arm64
docker compose --profile worker-arm64 up -d api qdrant caddy worker-arm64
docker compose ps
curl --fail https://your-backend.example.com/health
```

Do not use `docker compose down --volumes`; it deletes the named data volumes.

## Backups

Back up both state systems together:

- `api-state` contains SQLite jobs and leases;
- `qdrant-storage` contains live vectors and indexes;
- `qdrant-snapshots` contains explicit Qdrant snapshots.

Create a consistent SQLite backup inside its volume:

```bash
docker compose exec api python -c 'import sqlite3; source = sqlite3.connect("/var/lib/democratune/state.sqlite3"); target = sqlite3.connect("/var/lib/democratune/state-backup.sqlite3"); source.backup(target); target.close(); source.close()'
```

Create a single-node full Qdrant snapshot. This command executes inside the API
container so Qdrant remains private:

```bash
docker compose exec api python -c 'import os, httpx; response = httpx.post("http://qdrant:6333/snapshots", headers={"api-key": os.environ["QDRANT_API_KEY"]}, timeout=300); response.raise_for_status(); print(response.json())'
```

Copy both artifacts off the host or include their Docker volumes in an OCI
boot/block-volume backup:

```bash
mkdir -p backups
docker compose cp api:/var/lib/democratune/state-backup.sqlite3 backups/state-backup.sqlite3
docker compose cp qdrant:/qdrant/snapshots backups/qdrant-snapshots
```

OCI volume backups are crash-consistent, but application-level SQLite and
Qdrant snapshots give a clearer restore point. Keep at least one tested copy
outside the VM. Qdrant full-storage snapshot restore is a startup operation;
follow the documentation for the exact pinned Qdrant version and test it on a
separate volume before relying on it.

## Rollback and recovery

For an application-only rollback, check out the known-good commit, rebuild the
affected images, and run the same `docker compose ... up -d` command. Do not
delete or recreate named volumes during a code rollback.

If a storage migration or Qdrant upgrade is involved, stop and restore the
matched SQLite and Qdrant backups instead of attempting an in-place downgrade.
Validate `/health`, feature availability, and one recommendation request before
re-enabling job creation.

## Capacity and safety checks

- Keep `worker-arm64` at one CPU and 4 GB until measured throughput and peak
  memory justify a change.
- Monitor the boot/block volume; Docker layers, vectors, and snapshots all
  consume it.
- Keep Qdrant private and retain its API key even on the internal network.
- Never enqueue extraction jobs from search keystrokes. Enqueue only after a
  track is accepted into a room.
- Never store raw downloaded audio; the worker's temporary-file lifecycle is
  intentional.
- Review Essentia's AGPL/commercial terms and the applicable media-platform
  terms before public operation.

## References

- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [Docker Compose plugin](https://docs.docker.com/compose/install/linux/)
- [OCI Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [OCI boot-volume backups](https://docs.oracle.com/en-us/iaas/Content/Block/Concepts/bootvolumebackups.htm)
- [Qdrant snapshots](https://qdrant.tech/documentation/operations/snapshots/)
