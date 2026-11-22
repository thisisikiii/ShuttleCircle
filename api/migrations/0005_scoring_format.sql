-- Scoring format per match (FR-23): sets per game, points per set and the deuce cap.
-- Default 1 set to 21, capped at 30 (BWF), which is what every game used before.
ALTER TABLE matches
  ADD COLUMN rotation_best_of int NOT NULL DEFAULT 1  CHECK (rotation_best_of IN (1, 3, 5)),
  ADD COLUMN rotation_points  int NOT NULL DEFAULT 21 CHECK (rotation_points BETWEEN 1 AND 99),
  ADD COLUMN rotation_cap     int NOT NULL DEFAULT 30 CHECK (rotation_cap BETWEEN 1 AND 99),
  ADD CONSTRAINT matches_rotation_cap_points_check CHECK (rotation_cap >= rotation_points);

-- A game keeps the format it started with. `sets` holds finished sets as [[a, b], ...];
-- score_a/score_b hold the set being played. Games finished before this migration keep their single score.
ALTER TABLE rotation_games
  ADD COLUMN best_of int   NOT NULL DEFAULT 1,
  ADD COLUMN points  int   NOT NULL DEFAULT 21,
  ADD COLUMN cap     int   NOT NULL DEFAULT 30,
  ADD COLUMN sets    jsonb NOT NULL DEFAULT '[]';
