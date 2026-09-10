-- Migration 008 — attachments (PLAN-DATA-MODEL.md §3.6).
-- One polymorphic table for every file the system keeps: job photos,
-- signature photos, contract documents.
--
-- POLYMORPHIC, with NO FK on owner_id — deliberate (§3.6). The
-- alternative, five nullable FK columns plus an "exactly one is set"
-- CHECK, is worse to query and no safer in practice: the constraint
-- proves only that some uuid is set, not that the row it names exists
-- or is the right kind of row to hold this file. The cost is orphans
-- after a hard delete, and that is answered by the nightly
-- orphan-attachments cleanup job (PLAN-BACKEND.md §11, Phase 5), not by
-- a constraint pretending to be one.
--
-- owner_type carries job_card AND job_completion on purpose:
-- before-photos hang off the card (a dispatcher taking a fault report
-- by phone attaches the photo the customer sent; a technician takes a
-- "before" shot), after-photos off the completion — a distinction
-- worth having in the timeline (§3.6).
--
-- 'signature' is a photograph, not a drawing. There is no signature-pad
-- component in this product and this migration does not pretend to make
-- room for one: a signature drawn with a gloved finger on a phone in a
-- stairwell is a scribble with no evidential value, and the component
-- would cost real estate on the highest-stakes screen in the product.
-- job_completions.customer_signed (migration 007) is the boolean the
-- technician ticks — "customer confirmed the work"; where evidence is
-- genuinely wanted, kind = 'signature' labels a photo of the signed
-- paper docket.

CREATE TABLE attachments (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type  attachment_owner_type NOT NULL,
  owner_id    uuid NOT NULL, -- deliberately no FK — see the header note
  kind        attachment_kind NOT NULL, -- 'signature' is a photo of a paper docket

  -- The object key in S3-compatible storage, shape
  -- {ownerType}/{yyyy}/{mm}/{uuid}.{ext} (PLAN-BACKEND.md §9); unique
  -- because one stored object is one row, and the lookup by key (a
  -- retried upload, the nightly integrity sweep) is a point read.
  storage_key text NOT NULL,
  CONSTRAINT attachments_storage_key_unique UNIQUE (storage_key),

  -- The server validates MIME against image/jpeg|png|webp and
  -- application/pdf and re-encodes JPEG to a 1600px long edge before
  -- insert (PLAN-BACKEND.md §9) — the cap below is the same 15 MB the
  -- upload endpoint enforces, held here so a bypassed endpoint is still
  -- not a database full of videos.
  mime_type   text NOT NULL,
  size_bytes  integer NOT NULL
    CONSTRAINT attachments_size_capped CHECK (size_bytes <= 15728640), -- 15 MB

  -- Pixel dimensions after re-encode; documents may not have any.
  width       integer,
  height      integer,

  -- sha256 hex, computed by the server over the bytes it stored — the
  -- truncated-upload check at upload time and the integrity evidence
  -- afterwards.
  checksum_sha256 text NOT NULL,

  caption     text,
  uploaded_by uuid NOT NULL REFERENCES employees(id),

  -- The offline seam, same shape as job_events' pair: captured_at is
  -- the device clock at capture (what the timeline orders by),
  -- uploaded_at the server clock at landing (what sync debugging
  -- reads). A photo taken underground at 10:05 that uploads at 12:40
  -- belongs at 10:05 in the story.
  captured_at timestamptz NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);

-- §5 index plan lists no secondary index for attachments: lookups go by
-- storage_key (the unique constraint above) and the per-owner timeline
-- query does not justify one at this volume — add it with the query,
-- not ahead of it. Orphan cleanup scans by owner pairs weekly
-- (PLAN-BACKEND.md §11) and is allowed a seqscan.

CREATE TRIGGER attachments_touch BEFORE UPDATE ON attachments
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();
