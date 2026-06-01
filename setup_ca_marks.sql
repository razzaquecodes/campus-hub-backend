-- ==========================================
-- STEP 1: Create the ca_marks table
-- ==========================================
CREATE TABLE ca_marks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  roll_number TEXT NOT NULL,
  semester TEXT NOT NULL,
  subject_code TEXT NOT NULL,
  subject_name TEXT,
  ca_marks INTEGER,
  pca_marks INTEGER,
  total_marks INTEGER,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ==========================================
-- STEP 2: Add Unique Constraint for Upserts
-- ==========================================
-- This constraint ensures we can upsert records based on 
-- the combination of roll_number, semester, and subject_code
ALTER TABLE ca_marks 
  ADD CONSTRAINT ca_marks_roll_semester_subject_key 
  UNIQUE (roll_number, semester, subject_code);

-- ==========================================
-- STEP 3: Setup RLS (Optional, based on your security setup)
-- ==========================================
ALTER TABLE ca_marks ENABLE ROW LEVEL SECURITY;

-- Allow read access to everyone (if desired) or adjust as needed
CREATE POLICY "Allow public read access to ca_marks"
  ON ca_marks FOR SELECT
  USING (true);

-- Usually write access is done via the service_role key so no insert policy is strictly needed
