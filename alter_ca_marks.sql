-- ==========================================
-- ALTER TABLE ca_marks
-- Add columns for granular internal marks
-- ==========================================

ALTER TABLE ca_marks 
  ADD COLUMN IF NOT EXISTS ca1 INTEGER,
  ADD COLUMN IF NOT EXISTS ca2 INTEGER,
  ADD COLUMN IF NOT EXISTS ca3 INTEGER,
  ADD COLUMN IF NOT EXISTS ca4 INTEGER,
  ADD COLUMN IF NOT EXISTS pca1 INTEGER,
  ADD COLUMN IF NOT EXISTS pca2 INTEGER;
