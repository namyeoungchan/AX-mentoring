import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from scripts.lms_backup import backup, restore, verify


class BackupTests(unittest.TestCase):
    def fixture(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / 'main.db.workspaces').mkdir()
        for path in [root / 'main.db', root / 'main.db.workspaces' / 'workspace.db']:
            with sqlite3.connect(path) as db:
                db.execute('PRAGMA journal_mode=WAL')
                db.execute('CREATE TABLE sample(id INTEGER PRIMARY KEY,value TEXT)')
                db.execute("INSERT INTO sample VALUES(1,'preserved')")
        return root

    def test_wal_backups_restore_all_databases_into_new_location(self):
        root = self.fixture()
        # Keep a live WAL connection so this also covers committed data outside the main file.
        with sqlite3.connect(root / 'main.db') as connection:
            connection.execute("INSERT INTO sample VALUES(2,'committed WAL')"); connection.commit()
            result = backup(root / 'main.db', root / 'backup')
        self.assertEqual(len(result['files']), 2)
        verify(root / 'backup'); restore(root / 'backup', root / 'restore')
        with sqlite3.connect(root / 'restore' / 'main.db') as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM sample').fetchone()[0], 2)
        with sqlite3.connect(root / 'restore' / 'main.db.workspaces' / 'workspace.db') as db:
            self.assertEqual(db.execute('SELECT value FROM sample').fetchone()[0], 'preserved')
        with self.assertRaises(ValueError):
            restore(root / 'backup', root / 'restore')

    def test_tampering_and_manifest_traversal_are_rejected_before_restore(self):
        root = self.fixture(); backup(root / 'main.db', root / 'backup')
        manifest = root / 'backup' / 'manifest.json'
        original = json.loads(manifest.read_text())
        bad = json.loads(manifest.read_text()); bad['files'][0]['path'] = '../main.db'
        manifest.write_text(json.dumps(bad))
        with self.assertRaises(ValueError):
            restore(root / 'backup', root / 'restore')
        self.assertFalse((root / 'restore').exists())
        manifest.write_text(json.dumps(original))
        with (root / 'backup' / 'main.db').open('ab') as stream:
            stream.write(b'corruption')
        with self.assertRaises(ValueError):
            verify(root / 'backup')

    def test_missing_source_does_not_create_empty_database_or_overwrite_a_backup(self):
        root = self.fixture()
        with self.assertRaises(ValueError):
            backup(root / 'missing.db', root / 'backup')
        self.assertFalse((root / 'missing.db').exists())
        backup(root / 'main.db', root / 'backup')
        with self.assertRaises(ValueError):
            backup(root / 'main.db', root / 'backup')
