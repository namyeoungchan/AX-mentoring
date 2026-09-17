"""Verify a persistent pre-deployment SQLite backup before starting a service."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path

from lms_backup import backup, verify


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database_env')
    parser.add_argument('default_database')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not args.command:
        parser.error('A service command is required')
    source = Path(os.getenv(args.database_env) or args.default_database).resolve()
    if source.exists():
        root = source.parent / 'predeploy-backups'
        root.mkdir(mode=0o700, exist_ok=True)
        commit = os.getenv('RENDER_GIT_COMMIT', '')
        identity = hashlib.sha256(commit.encode()).hexdigest()[:20] if commit else datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        destination = root / f'{source.name}-{identity}'
        reused = destination.exists()
        if not reused:
            backup(source, destination)
        manifest = verify(destination)
        print(json.dumps({'prestartBackup': 'verified', 'path': str(destination), 'databases': len(manifest['files']), 'reused': reused}), flush=True)
    else:
        print(json.dumps({'prestartBackup': 'new-database', 'path': str(source)}), flush=True)
    # Any backup or verification failure exits before application imports/migrations.
    os.execvp(args.command[0], args.command)


if __name__ == '__main__':
    main()
