-- Simplified schema of the authorization bounded context (MySQL 8).

CREATE TABLE scopes (
  code  VARCHAR(32) PRIMARY KEY,          -- 'own', 'team', 'all', ...
  level INT NOT NULL                      -- lowest = own, highest = all, in between = org-tree filter
);

CREATE TABLE org_units (
  id        INT PRIMARY KEY AUTO_INCREMENT,
  parent_id INT NULL REFERENCES org_units(id),   -- company -> department -> team -> sub-team
  name      VARCHAR(255) NOT NULL
);

CREATE TABLE roles (
  id             INT PRIMARY KEY AUTO_INCREMENT,
  code           VARCHAR(64) UNIQUE NOT NULL,
  parent_role_id INT NULL REFERENCES roles(id),  -- inheritance; must stay acyclic
  is_active      BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE permissions (
  id       INT PRIMARY KEY AUTO_INCREMENT,
  resource VARCHAR(64) NOT NULL,
  action   VARCHAR(64) NOT NULL,
  UNIQUE (resource, action)
);

-- The scope lives on the grant, not on the user.
CREATE TABLE role_permissions (
  role_id       INT NOT NULL REFERENCES roles(id),
  permission_id INT NOT NULL REFERENCES permissions(id),
  scope         VARCHAR(32) NOT NULL REFERENCES scopes(code),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  user_id       CHAR(36) PRIMARY KEY,
  role_id       INT NOT NULL REFERENCES roles(id),        -- phase 1: one role per user
  org_unit_id   INT NULL REFERENCES org_units(id),
  status        ENUM('active','inactive') NOT NULL,
  locked_until  BIGINT NULL,
  token_version INT NOT NULL DEFAULT 1                    -- bump = revoke every issued token
);

-- Many-to-many: one person can lead several units in different branches.
CREATE TABLE org_unit_leaders (
  org_unit_id INT NOT NULL REFERENCES org_units(id),
  user_id     CHAR(36) NOT NULL REFERENCES users(user_id),
  PRIMARY KEY (org_unit_id, user_id)
);

-- Transactional outbox for cache revocation.
CREATE TABLE invalidation_outbox (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_ids    JSON NOT NULL,
  status      ENUM('PENDING','PROCESSING','COMPLETED','FAILED') NOT NULL DEFAULT 'PENDING',
  retry_count INT NOT NULL DEFAULT 0,
  last_error  TEXT NULL,
  created_at  BIGINT NOT NULL,
  updated_at  BIGINT NOT NULL,
  INDEX (status, created_at)
);

-- ---------------------------------------------------------------------------
-- 1. Permissions with inheritance (walk UP the role tree)
WITH RECURSIVE role_chain AS (
  SELECT id, parent_role_id FROM roles WHERE id = ?
  UNION ALL
  SELECT r.id, r.parent_role_id FROM roles r JOIN role_chain rc ON r.id = rc.parent_role_id
)
SELECT p.resource, p.action, rp.scope
FROM role_chain rc
JOIN role_permissions rp ON rp.role_id = rc.id
JOIN permissions p       ON p.id = rp.permission_id;

-- 2. Users affected by a role change (walk DOWN the role tree)
WITH RECURSIVE descendants AS (
  SELECT id FROM roles WHERE id = ?
  UNION ALL
  SELECT r.id FROM roles r JOIN descendants d ON r.parent_role_id = d.id
)
SELECT user_id FROM users WHERE role_id IN (SELECT id FROM descendants) AND status = 'active';

-- 3. Org subtree (cached per unit as org:subtree:{id})
WITH RECURSIVE subtree AS (
  SELECT id FROM org_units WHERE id = ?
  UNION ALL
  SELECT o.id FROM org_units o JOIN subtree s ON o.parent_id = s.id
)
SELECT id FROM subtree;

-- 4. Cycle check before setting roles.parent_role_id = :newParent on :target
WITH RECURSIVE ancestors AS (
  SELECT id, parent_role_id FROM roles WHERE id = ?          -- :newParent
  UNION ALL
  SELECT r.id, r.parent_role_id FROM roles r JOIN ancestors a ON r.id = a.parent_role_id
)
SELECT 1 FROM ancestors WHERE id = ? LIMIT 1;                -- :target -> cycle if a row comes back

-- 5. Changing permissions: data + outbox in ONE transaction
START TRANSACTION;
  DELETE FROM role_permissions WHERE role_id = ?;
  INSERT INTO role_permissions (role_id, permission_id, scope) VALUES (?, ?, ?) /* , ... */;
  INSERT INTO invalidation_outbox (user_ids, status, created_at, updated_at)
  VALUES (?, 'PENDING', ?, ?);                               -- user ids from query 2
COMMIT;
