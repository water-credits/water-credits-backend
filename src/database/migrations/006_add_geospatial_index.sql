CREATE EXTENSION IF NOT EXISTS cube;
CREATE EXTENSION IF NOT EXISTS earthdistance;

CREATE INDEX IF NOT EXISTS idx_projects_geo
  ON projects
  USING gist (ll_to_earth(latitude, longitude));