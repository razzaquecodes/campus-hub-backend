-- Create a unique constraint for the student_grades table to support ON CONFLICT upserting
ALTER TABLE public.student_grades 
ADD CONSTRAINT unique_student_grade 
UNIQUE (roll_number, semester, subject_code);
