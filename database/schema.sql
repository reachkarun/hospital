-- MySQL 8.4+. Run explicitly with an administrative account before starting the API.
-- This script creates structure only: no application startup DDL or seed data.
CREATE DATABASE IF NOT EXISTS rounding_app CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
USE rounding_app;

CREATE TABLE IF NOT EXISTS hospitals (
  id VARCHAR(128) PRIMARY KEY, name VARCHAR(255) NOT NULL, billing_url VARCHAR(2048) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS audit (
  sequence BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  service VARCHAR(32) NOT NULL, hospital VARCHAR(128) NOT NULL,
  actor VARCHAR(255) NOT NULL, action VARCHAR(128) NOT NULL, resource VARCHAR(255) NOT NULL,
  at VARCHAR(32) NOT NULL,
  INDEX audit_scope(service,hospital,sequence)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS patient_entities (
  hospital VARCHAR(128) NOT NULL, kind VARCHAR(32) NOT NULL, id VARCHAR(128) NOT NULL,
  body JSON NOT NULL, PRIMARY KEY(hospital,kind,id),
  FOREIGN KEY(hospital) REFERENCES hospitals(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS patient_field_clocks (
  hospital VARCHAR(128) NOT NULL, kind VARCHAR(32) NOT NULL, entity_id VARCHAR(128) NOT NULL,
  field VARCHAR(128) NOT NULL, stamp VARCHAR(255) NOT NULL,
  PRIMARY KEY(hospital,kind,entity_id,field)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS patient_inbox (
  sequence BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  hospital VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL, digest CHAR(64) NOT NULL,
  body JSON NOT NULL, status VARCHAR(32) NOT NULL, error VARCHAR(128), received_at VARCHAR(32) NOT NULL,
  PRIMARY KEY(hospital,id), INDEX inbox_pending(hospital,status),
  FOREIGN KEY(hospital) REFERENCES hospitals(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS charge_submissions (
  hospital VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL, provider VARCHAR(128) NOT NULL,
  client_key VARCHAR(128) NOT NULL, digest CHAR(64) NOT NULL, payload JSON NOT NULL,
  status VARCHAR(32) NOT NULL, attempts INT NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0, lease_until BIGINT NOT NULL DEFAULT 0,
  lease_token VARCHAR(128), first_attempt BIGINT, response JSON, error VARCHAR(128),
  dispatch_at BIGINT NOT NULL DEFAULT 0, dispatch_lease BIGINT NOT NULL DEFAULT 0,
  dispatch_token VARCHAR(128), retry_request VARCHAR(128),
  PRIMARY KEY(hospital,id), UNIQUE KEY charge_client_key(hospital,provider,client_key),
  INDEX charge_dispatch_due(status,dispatch_at,dispatch_lease),
  FOREIGN KEY(hospital) REFERENCES hospitals(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS charges (
  hospital VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL, provider VARCHAR(128) NOT NULL,
  visit VARCHAR(128) NOT NULL, body JSON NOT NULL, version INT NOT NULL, status VARCHAR(32) NOT NULL,
  error JSON, submission VARCHAR(128), PRIMARY KEY(hospital,id),
  INDEX charges_owner(hospital,provider,id), INDEX charges_submission(hospital,submission),
  FOREIGN KEY(hospital) REFERENCES hospitals(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS charge_revisions (
  hospital VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL, version INT NOT NULL,
  body JSON NOT NULL, status VARCHAR(32) NOT NULL, error JSON, submission VARCHAR(128),
  at VARCHAR(32) NOT NULL, PRIMARY KEY(hospital,id,version)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS charge_operations (
  hospital VARCHAR(128) NOT NULL, provider VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL,
  digest CHAR(64) NOT NULL, response JSON NOT NULL, PRIMARY KEY(hospital,provider,id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS billing_submissions (
  hospital VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL, provider VARCHAR(128) NOT NULL,
  client_key VARCHAR(128) NOT NULL, digest CHAR(64) NOT NULL, payload JSON NOT NULL,
  status VARCHAR(32) NOT NULL, attempts INT NOT NULL DEFAULT 0,
  next_at BIGINT NOT NULL DEFAULT 0, lease_until BIGINT NOT NULL DEFAULT 0,
  lease_token VARCHAR(128), first_attempt BIGINT, response JSON, error VARCHAR(128),
  PRIMARY KEY(hospital,id), UNIQUE KEY billing_client_key(hospital,provider,client_key),
  INDEX billing_due(status,next_at,lease_until),
  FOREIGN KEY(hospital) REFERENCES hospitals(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS billing_retry_receipts (
  hospital VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL, operation VARCHAR(128) NOT NULL,
  PRIMARY KEY(hospital,id,operation)
) ENGINE=InnoDB;

-- Only used when the optional external billing simulator is enabled.
CREATE TABLE IF NOT EXISTS mock_results (
  hospital VARCHAR(128) NOT NULL, id VARCHAR(128) NOT NULL, client_key VARCHAR(128) NOT NULL,
  digest CHAR(64) NOT NULL, response JSON NOT NULL, created_at BIGINT NOT NULL,
  PRIMARY KEY(hospital,id), UNIQUE KEY mock_client_key(hospital,client_key)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS mock_modes (
  hospital VARCHAR(128) PRIMARY KEY, mode VARCHAR(32) NOT NULL, remaining INT NOT NULL
) ENGINE=InnoDB;

CREATE TRIGGER IF NOT EXISTS charge_insert_revision AFTER INSERT ON charges FOR EACH ROW
  INSERT INTO charge_revisions VALUES(NEW.hospital,NEW.id,NEW.version,NEW.body,NEW.status,NEW.error,NEW.submission,
    CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.'),LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'),'Z'));
CREATE TRIGGER IF NOT EXISTS charge_update_revision AFTER UPDATE ON charges FOR EACH ROW
  INSERT INTO charge_revisions VALUES(NEW.hospital,NEW.id,NEW.version,NEW.body,NEW.status,NEW.error,NEW.submission,
    CONCAT(DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.'),LPAD(FLOOR(MICROSECOND(UTC_TIMESTAMP(3))/1000),3,'0'),'Z'));
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='audit is append-only';
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='audit is append-only';
CREATE TRIGGER IF NOT EXISTS revision_no_update BEFORE UPDATE ON charge_revisions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='revisions are append-only';
CREATE TRIGGER IF NOT EXISTS revision_no_delete BEFORE DELETE ON charge_revisions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='revisions are append-only';
