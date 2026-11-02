# config

Compose mounts this directory read-only into the `api` and `worker` containers at `/app/config`. Their working directory is `/app`.

`pnpm dispatch init` writes a new senders file here as `config/senders.json` and sets `SENDERS_FILE=config/senders.json` in `.env`. The API, the worker and `pnpm dispatch doctor` then read the same file, whether they run under Compose or from this checkout. To use a senders file you wrote yourself, put it here and set `SENDERS_FILE` the same way.

Git ignores everything in this directory except this README, since a senders file can hold a Safe API key.
