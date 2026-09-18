import json
import os
from pathlib import Path
import sqlite3
from contextlib import closing
import subprocess
import sys
import tempfile
import unittest


class PrestartBackupTests(unittest.TestCase):
    def test_legacy_start_records_existing_violations_without_modifying_source(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'main.db'
            with closing(sqlite3.connect(source)) as db, db:
                db.executescript('CREATE TABLE parent(id PRIMARY KEY); CREATE TABLE child(parent_id REFERENCES parent(id)); INSERT INTO child VALUES(42);')
            result = self.start(source, legacy=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout.splitlines()[0])['legacyForeignKeyViolations'], 1)
            self.assertIn('SERVICE_STARTED', result.stdout)
            with closing(sqlite3.connect(source)) as db, db:
                self.assertEqual(db.execute('SELECT parent_id FROM child').fetchone()[0], 42)

    def test_backup_precedes_command_and_is_reused_for_the_same_deployment(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'main.db'
            with closing(sqlite3.connect(source)) as db, db:
                db.execute('CREATE TABLE sample(value)')
                db.execute("INSERT INTO sample VALUES ('before')")
            result = self.start(source)
            self.assertEqual(result.returncode, 0, result.stderr)
            record = json.loads(result.stdout.splitlines()[0])
            self.assertEqual(record['prestartBackup'], 'verified')
            self.assertIn('SERVICE_STARTED', result.stdout)
            with closing(sqlite3.connect(source)) as db, db:
                db.execute("UPDATE sample SET value='after'")
            repeated = self.start(source)
            self.assertEqual(repeated.returncode, 0, repeated.stderr)
            self.assertTrue(json.loads(repeated.stdout.splitlines()[0])['reused'])
            with closing(sqlite3.connect(Path(record['path']) / 'main.db')) as db, db:
                self.assertEqual(db.execute('SELECT value FROM sample').fetchone()[0], 'before')
            (Path(record['path']) / 'main.db').write_bytes(b'corrupt')
            failed = self.start(source)
            self.assertNotEqual(failed.returncode, 0)
            self.assertNotIn('SERVICE_STARTED', failed.stdout)

    def test_corrupt_source_prevents_start_and_fresh_install_is_allowed(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'main.db'
            fresh = self.start(source)
            self.assertEqual(fresh.returncode, 0, fresh.stderr)
            self.assertFalse(source.exists())
            source.write_bytes(b'not a database')
            failed = self.start(source)
            self.assertNotEqual(failed.returncode, 0)
            self.assertNotIn('SERVICE_STARTED', failed.stdout)

    def start(self, source, legacy=False):
        return subprocess.run([
            sys.executable, str(Path(__file__).resolve().parents[1] / 'scripts/start_with_backup.py'),
            *(['--allow-existing-foreign-key-errors'] if legacy else []),
            'TEST_BACKUP_DB', 'unused.db', sys.executable, '-c', "print('SERVICE_STARTED')",
        ], env={**os.environ, 'TEST_BACKUP_DB': str(source), 'RENDER_GIT_COMMIT': 'test-release'}, text=True, capture_output=True)
