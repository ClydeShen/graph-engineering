-- Migration 001: PostgreSQL extensions
-- Installs pgcrypto (for digest() in version hash computation — ADR 02)
-- and pgvector (for vector(128) topology embeddings — ADR 25, ADR 20).
-- Idempotent: CREATE EXTENSION IF NOT EXISTS.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
