"""Snapshot LMS SQLite databases and verify/restore into a NEW directory only."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
from datetime import datetime, timezone


def checksum(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def check(path):
    with sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True) as db:
        if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
            raise ValueError(f'Integrity check failed: {path.name}')
        if db.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError(f'Foreign key check failed: {path.name}')


def snapshot(source, destination):
    with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True) as source_db:
        with sqlite3.connect(destination) as target_db:
            source_db.backup(target_db)
    check(destination)


def backup(source, output):
    source, output = Path(source).resolve(), Path(output).absolute()
    if not source.is_file():
        raise ValueError('Source database does not exist')
    workspace_dir = source.parent / (source.name + '.workspaces')
    def files():
        return [source, *sorted(workspace_dir.glob('*.db'))]
    inputs = files()
    if any(path.is_symlink() for path in inputs):
        raise ValueError('Database symlinks are not supported')
    if output.exists() or output.is_symlink():
        raise ValueError('Backup output must be a new directory')
    if output.resolve().is_relative_to(workspace_dir.resolve()):
        raise ValueError('Backup must be outside the workspace database directory')
    output.mkdir(parents=True, mode=0o700)
    manifest = {'version': 1, 'createdAt': datetime.now(timezone.utc).isoformat(), 'main': source.name, 'files': []}
    for path in inputs:
        relative = path.relative_to(source.parent)
        target = output / relative
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        snapshot(path, target)
        target.chmod(0o600)
        manifest['files'].append({'path': relative.as_posix(), 'sha256': checksum(target), 'bytes': target.stat().st_size})
    if files() != inputs:
        raise ValueError('Workspace database set changed; retry in a maintenance window')
    # The manifest is written last: an interrupted backup is never a valid backup set.
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    (output / 'manifest.json').chmod(0o600)
    return manifest


def verify(directory):
    directory = Path(directory).resolve()
    manifest = json.loads((directory / 'manifest.json').read_text(encoding='utf-8'))
    if manifest.get('version') != 1 or not isinstance(manifest.get('files'), list) or not manifest['files']:
        raise ValueError('Unsupported or empty manifest')
    seen = set()
    for entry in manifest['files']:
        relative = Path(entry['path'])
        if relative.is_absolute() or '..' in relative.parts or relative.as_posix() in seen:
            raise ValueError('Invalid or duplicate manifest path')
        seen.add(relative.as_posix())
        path = directory / relative
        if path.is_symlink() or not path.resolve().is_relative_to(directory) or not path.is_file():
            raise ValueError('Backup file is missing or outside the backup directory')
        if path.stat().st_size != entry['bytes'] or checksum(path) != entry['sha256']:
            raise ValueError(f'Checksum mismatch: {relative}')
        check(path)
    if manifest.get('main') not in seen:
        raise ValueError('Main database is missing')
    return manifest


def restore(directory, output):
    manifest = verify(directory)
    directory, output = Path(directory).resolve(), Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise ValueError('Restore output must be a new directory; existing data is never overwritten')
    output.mkdir(parents=True, mode=0o700)
    for entry in manifest['files']:
        target = output / entry['path']
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copyfile(directory / entry['path'], target)
        target.chmod(0o600)
        check(target)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    create = sub.add_parser('backup'); create.add_argument('--source', required=True); create.add_argument('--output', required=True)
    validate = sub.add_parser('verify'); validate.add_argument('--backup', required=True)
    recover = sub.add_parser('restore'); recover.add_argument('--backup', required=True); recover.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.action == 'backup':
        result = backup(args.source, args.output)
    elif args.action == 'restore':
        result = restore(args.backup, args.output)
    else:
        result = verify(args.backup)
    print(json.dumps({'action': args.action, 'databases': len(result['files']), 'backupCreatedAt': result['createdAt']}))


if __name__ == '__main__':
    main()
