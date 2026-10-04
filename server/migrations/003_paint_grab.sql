-- Paint Grab: per-run score breakdown, UTC day binding, daily bests and the immutable board.
-- Additive and retry-safe; keep when rolling code back.
ALTER TABLE game_lb_runs
 ADD COLUMN IF NOT EXISTS run_day CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD COLUMN IF NOT EXISTS territory_bp INT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS kills INT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS combo_bonus INT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS captures INT UNSIGNED NULL,
 ADD COLUMN IF NOT EXISTS survived BOOLEAN NULL;
CREATE TABLE IF NOT EXISTS game_lb_daily_best (
 namespace VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 board_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 day CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 player_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 score BIGINT NOT NULL, rank_value BIGINT NOT NULL,
 achieved_at DATETIME(3) NOT NULL,
 run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
 PRIMARY KEY(namespace,board_id,day,player_id),
 KEY ranking(namespace,board_id,day,rank_value,achieved_at,player_id)
);
INSERT IGNORE INTO game_lb_boards
(namespace,id,rules_version,direction,min_score,max_score,min_duration_ms,max_duration_ms,`open`)
VALUES
('production','paint-v1','v1','desc',0,120000,1000,92000,TRUE);
