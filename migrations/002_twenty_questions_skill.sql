-- Register twenty_questions skill: play 20 Questions (Bo thinks of something, user asks yes/no, guess in 20 to win).
INSERT INTO skills_registry (id, name, description, entrypoint, input_schema)
VALUES (
  'twenty_questions',
  'Twenty Questions',
  'Play 20 Questions: Bo thinks of something, you ask yes/no questions. Guess it in 20 or fewer to win.',
  'scripts/skills/twenty_questions.ts',
  '{"type":"object","properties":{"action":{"type":"string","description":"start, question, guess, or status"},"category":{"type":"string","description":"Category for start (e.g. animal, food)"},"question":{"type":"string","description":"Yes/no question"},"guess":{"type":"string","description":"Player guess"}},"required":["action"]}'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  entrypoint = EXCLUDED.entrypoint,
  input_schema = EXCLUDED.input_schema;

-- Allow skill by default for all users.
INSERT INTO skills_access_default (skill_id)
VALUES ('twenty_questions')
ON CONFLICT (skill_id) DO NOTHING;
