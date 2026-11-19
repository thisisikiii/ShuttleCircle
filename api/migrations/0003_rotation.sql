-- Court rotation (FR-19): fair turns on the courts during a match.
CREATE TYPE rotation_state       AS ENUM ('waiting','resting','left');
CREATE TYPE rotation_game_status AS ENUM ('next','playing','done');

ALTER TABLE matches ADD COLUMN rotation_singles boolean NOT NULL DEFAULT false;

-- One row per court of a match. Gender mode: any, mixed, men, women. Level mode: off, balanced, mixed.
CREATE TABLE rotation_courts (
  match_id    uuid NOT NULL REFERENCES matches(id),
  court       int  NOT NULL CHECK (court BETWEEN 1 AND 20),
  gender_mode text NOT NULL DEFAULT 'any' CHECK (gender_mode IN ('any','mixed','men','women')),
  level_mode  text NOT NULL DEFAULT 'off' CHECK (level_mode IN ('off','balanced','mixed')),
  PRIMARY KEY (match_id, court)
);

-- A confirmed player who has arrived. No row = not arrived yet.
CREATE TABLE rotation_players (
  join_request_id uuid PRIMARY KEY REFERENCES join_requests(id),
  match_id        uuid NOT NULL REFERENCES matches(id),
  state           rotation_state NOT NULL DEFAULT 'waiting',
  gender          char(1) CHECK (gender IN ('M','F')),
  level           smallint CHECK (level BETWEEN 1 AND 3),   -- 1 beginner, 2 intermediate, 3 advanced; null counts as 1
  arrived_at      timestamptz NOT NULL DEFAULT now(),
  wait_since      timestamptz NOT NULL DEFAULT now(),       -- last game end, arrival or return from rest
  play_floor      int NOT NULL DEFAULT 0                    -- fewest games of the others when this player (re)joined the queue
);
CREATE INDEX rotation_players_match_idx ON rotation_players(match_id);

CREATE TABLE rotation_games (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id   uuid NOT NULL REFERENCES matches(id),
  court      int  NOT NULL,
  status     rotation_game_status NOT NULL DEFAULT 'next',
  team_a     uuid[] NOT NULL,     -- join_request ids
  team_b     uuid[] NOT NULL,
  score_a    int CHECK (score_a >= 0),
  score_b    int CHECK (score_b >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at   timestamptz
);
CREATE INDEX rotation_games_match_idx ON rotation_games(match_id, created_at);
CREATE UNIQUE INDEX rotation_games_one_next    ON rotation_games(match_id, court) WHERE status = 'next';
CREATE UNIQUE INDEX rotation_games_one_playing ON rotation_games(match_id, court) WHERE status = 'playing';
