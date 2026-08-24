-- Migration 019: Link oracle submissions to their reading batch (issue #100)
--
-- The oracle processor must credit the batch that was actually aggregated for
-- a submission.  A nullable FK keeps legacy submissions/jobs valid while new
-- submissions carry the durable association needed at confirmation time.

ALTER TABLE oracle_submissions
    ADD COLUMN IF NOT EXISTS batch_id UUID NULL;

ALTER TABLE oracle_submissions
    ADD CONSTRAINT fk_oracle_submissions_batch
    FOREIGN KEY (batch_id)
    REFERENCES reading_batches(id)
    ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_oracle_submissions_batch
    ON oracle_submissions (batch_id);
