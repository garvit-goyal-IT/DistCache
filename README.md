# DistCache — Distributed Rate Limiter & Cache Layer

A distributed rate limiting service built with Redis, consistent hashing, and Docker. Built to explore how production systems like Cloudflare and Stripe enforce per-client request quotas at scale.

## What it does

DistCache enforces a per-client request quota (default: 5 requests per 60-second window) across a simulated cluster of 3 Redis nodes. Each client is deterministically routed to one of the nodes using consistent hashing, and a distributed lock prevents race conditions when multiple requests from the same client arrive concurrently.

## Architecture

```
                    ┌─────────────┐
   Client Request → │   Express   │
                    │   Server    │
                    └──────┬──────┘
                           │
                  ┌────────▼─────────┐
                  │ Consistent Hash  │
                  │      Ring        │  ← decides which node owns this client
                  └────────┬─────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
  ┌──────────┐      ┌──────────┐      ┌──────────┐
  │ Redis    │      │ Redis    │      │ Redis    │
  │ Node A   │      │ Node B   │      │ Node C   │
  └──────────┘      └──────────┘      └──────────┘
```

**Request flow:**
1. Client sends a request, identified by IP (or `x-client-id` header for testing).
2. Consistent hash ring deterministically maps the client to one of 3 Redis nodes.
3. A distributed lock (`SET NX EX`) is acquired on that node to prevent race conditions.
4. The current request count is checked against the limit.
5. If under the limit: counter is incremented, request succeeds.
6. If at/over the limit: request is rejected with `429 Too Many Requests`.
7. Lock is released (guaranteed via `finally`, even on error).

## Key design decisions

**Why Token Bucket over Sliding Window?**
Token Bucket is simpler to implement with Redis's atomic `INCR`/`EXPIRE` and sufficient for this use case. Sliding Window Log offers better precision at request-window boundaries but requires storing a timestamp per request — more memory for more accuracy. This is a known tradeoff in rate limiter design.

**Why consistent hashing instead of `hash(key) % N`?**
Naive modulo hashing remaps nearly all keys when a node is added or removed, causing a full cache invalidation. Consistent hashing with virtual nodes (100 per physical node) limits remapping to approximately `1/N` of keys. This was empirically validated: adding a 4th node to a 3-node ring remapped 25.6% of test keys, closely matching the theoretical 25% prediction.

**Why a distributed lock instead of relying on `INCR` alone?**
The check-then-act sequence (`GET` → compare to limit → `INCR`) is not atomic across multiple Redis commands. Two concurrent requests could both read the same pre-increment value and both pass the limit check, allowing more requests through than intended. The lock, acquired via `SET NX EX`, ensures only one request executes this sequence at a time per client. The TTL on the lock prevents permanent deadlock if the server crashes mid-request; the `finally` block ensures release even if an exception is thrown.

**Why fail-fast instead of retry-with-backoff on lock contention?**
Lock contention on the same key generally indicates the same client sending requests faster than the lock cycle allows — behavior a rate limiter is designed to catch. Retrying would add latency to protect against a scenario that already signals excessive request rate.

## Tech stack

- **Node.js + Express** — API server
- **Redis** (3 containerized instances) — distributed counters and locks
- **Docker Compose** — orchestrates app + Redis nodes with healthchecks
- **Consistent hashing** (custom implementation, no external library)

## Running it

```bash
docker-compose up --build
```

This starts the Express app and 3 Redis containers. Healthchecks ensure Redis is ready before the app attempts to connect, avoiding startup race conditions.

Test it:

```bash
curl http://localhost:3000/api/resource
```

Simulate multiple clients:

```bash
curl -H "x-client-id: client1" http://localhost:3000/api/resource
```

## Validation & testing

- **Consistent hashing correctness:** verified via `node consistentHash.js`, which adds a 4th node to a 3-node ring and measures key remapping across 1000 simulated clients (result: 25.6%, vs. 25% theoretical).
- **Rate limit correctness:** verified manually and via `curl` loops — each client gets exactly 5 successful requests before being rejected, independent of which Redis node they're routed to.
- **Concurrency safety:** load tested with `autocannon` at 50 concurrent connections; confirmed the distributed lock prevents more than the allowed requests from succeeding under simultaneous load from a single client.

## Known limitations & future improvements

- Client identification currently uses IP address, which fails behind NAT (e.g., shared office/college networks). Production systems would use authenticated user/API keys as the primary identifier, falling back to IP for anonymous traffic.
- Lock contention uses fail-fast rather than retry-with-backoff; this is a deliberate tradeoff (see above) but worth revisiting for latency-sensitive use cases.
- No persistence layer beyond Redis's own defaults — a production version would consider Redis persistence (RDB/AOF) for crash recovery of rate-limit state.