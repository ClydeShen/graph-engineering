-- Migration 004: bus_state — High-Water Mark table
--
-- bus_state tracks the last processed event ID per worker (High-Water Mark / HWM).
-- The Pulse-Fetch bridge in the Control Plane advances this value atomically after
-- each LISTEN/NOTIFY callback, ensuring exactly-once-semantics for the HWM position.
-- If the Control Plane restarts, it reads this table to resume from the last known
-- good position rather than reprocessing all events. (ADR 09, ADR 32 D-4)
--
-- worker_id is a logical identifier for the subscriber (e.g., 'control-plane').
-- Multiple subscribers can track independent HWM positions in the same table.

CREATE TABLE IF NOT EXISTS bus_state (
    -- Logical worker identifier (e.g., 'control-plane', 'frontier-scheduler')
    worker_id               TEXT        PRIMARY KEY,
    -- Last event ID that was fully processed by this worker.
    -- Default 0 means no events processed yet (fresh start).
    last_processed_event_id BIGINT      NOT NULL DEFAULT 0
);
