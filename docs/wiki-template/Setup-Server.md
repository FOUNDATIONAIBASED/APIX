# Server setup

## Prerequisites

- Node.js 18+
- SQLite (bundled path under `server/data/` by default)

## Install

```bash
cd server
npm ci
cp .env.example .env   # if present; edit secrets
```

## Run

```bash
npm start
```

## Notes

_Add environment-specific URLs, TLS termination, reverse proxy rules, etc. here in your local `wiki/` copy._
