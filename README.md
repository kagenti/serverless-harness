# Serverless Harness (Pi track)

## Packages
- `packages/session-backend` — generic append-only `LogStore` + Redis Streams impl.
- `harness` — Pi `SessionStorageBackend` adapter (write-behind) + headless smoke.
- `pi-fork` — pinned Pi (base commit `406a2214`, branch `feat/session-storage-backend`) with the injectable `SessionStorageBackend` seam.
