"""Run one allowlisted legacy operation atomically against the web-owned database."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import inspect
import json
import os
import sqlite3
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
os.environ.update(DISCORD_TOKEN="storage-process", GUILD_ID="0", ADMIN_ROLE_ID="0", ONBOARDING_CHANNEL_ID="0", INTRO_CHANNEL_ID="0", DB_PATH=":memory:")
import aiosqlite
import database
from storage_codec import encode, decode

READ_ONLY = frozenset(json.loads((Path(__file__).resolve().parents[2] / "storage_operations.json").read_text())["readOnly"])


class ConnectionScope:
    def __init__(self, connection):
        self.connection = connection

    async def __aenter__(self):
        # Legacy methods set row_factory on each logical connection.
        self.connection.row_factory = None
        return self

    async def __aexit__(self, *_):
        return False

    @property
    def row_factory(self):
        return self.connection.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self.connection.row_factory = value

    def execute(self, sql, parameters=()):
        if sql.strip().upper().startswith("BEGIN"):
            sql = "SELECT 1"
        return self.connection.execute(sql, parameters)

    async def commit(self):
        pass  # The operation and its receipt commit together below.


@asynccontextmanager
async def operation_connection(filename, schema, read_only):
    if schema:
        from postgres_legacy import connect
        connection = await connect(os.environ['DATABASE_URL'], schema, read_only)
        try:
            yield connection
        finally:
            await connection.raw.close()
    else:
        async with aiosqlite.connect(filename) as connection:
            await connection.execute("PRAGMA foreign_keys=ON")
            await connection.execute("PRAGMA busy_timeout=5000")
            if read_only:
                await connection.execute("PRAGMA query_only=ON")
            await connection.execute("BEGIN" if read_only else "BEGIN IMMEDIATE")
            yield connection


async def run(request, filename, schema=None):
    database.DB_PATH = filename
    operation = request["operation"]
    fn = getattr(database, operation, None)
    if operation.startswith("_") or operation == "init_db" or not inspect.iscoroutinefunction(fn) or fn.__module__ != "database":
        raise ValueError("Unsupported operation")
    args, kwargs = decode(request.get("args", [])), decode(request.get("kwargs", {}))
    bound = inspect.signature(fn).bind(*args, **kwargs)
    bound.apply_defaults()
    validate(operation, bound.arguments, request["guildId"])
    database.online_mentor_ids.set(frozenset(request.get('onlineMentorIds', [])))
    if operation in ('set_slot_template', 'generate_slots_for_range') and bound.arguments['mentor_id'] not in database.online_mentor_ids.get():
        raise ValueError('온라인 멘토링 가능 시간은 인증된 조 담당 멘토만 등록할 수 있습니다.')
    fingerprint = hashlib.sha256(json.dumps({"operation": operation, "args": request.get("args", []), "kwargs": request.get("kwargs", {})}, sort_keys=True).encode()).hexdigest()
    original_connect = aiosqlite.connect
    read_only = operation in READ_ONLY
    async with operation_connection(filename, schema, read_only) as connection:
        try:
            async with connection.execute("SELECT fingerprint,result FROM lms_storage_receipts WHERE id=?", (request["requestId"],)) as rows:
                cached = await rows.fetchone()
            if cached:
                if cached[0] != fingerprint:
                    raise ValueError("Request ID conflict")
                await connection.rollback()
                return json.loads(cached[1])
            if request.get("revision") is not None:
                async with connection.execute("SELECT revision FROM lms_storage_state WHERE id=1") as rows:
                    revision = (await rows.fetchone())[0]
                if str(revision) != request["revision"]:
                    raise ValueError("stale_revision")
            aiosqlite.connect = lambda *_args, **_kwargs: ConnectionScope(connection)
            course_id = None
            if operation == 'create_assignment':
                async with connection.execute("SELECT id FROM lms_records WHERE kind='courses'") as rows:
                    courses = [row[0] for row in await rows.fetchall()]
                course_id = bound.arguments.get('course_id')
                if not course_id and len(courses) == 1:
                    course_id = courses[0]
                if not course_id or course_id not in courses:
                    raise ValueError('assignment_course_required')
            if operation == 'delete_assignment':
                assignment_id = bound.arguments['assignment_id']
                # The worker owns these web-only relationships. All cleanup and the
                # legacy delete share the same transaction and retry receipt.
                for table in ('lms_assignment_courses', 'lms_assignment_publications'):
                    await connection.execute(f'DELETE FROM {table} WHERE assignment_id=?', (assignment_id,))
                await connection.execute("UPDATE lms_outbox SET state='cancelled',claim=NULL,error='assignment_removed' WHERE source_id=? AND kind IN ('submission','reminder','publication') AND state IN ('pending','failed','held','reconcile','uncertain')", (str(assignment_id),))
            result = encode(await fn(*bound.args, **bound.kwargs))
            if operation == 'create_assignment':
                await connection.execute('INSERT INTO lms_assignment_courses(assignment_id,course_id) VALUES(?,?)', (result, course_id))
            aiosqlite.connect = original_connect
            # Query methods have no write receipt; retries of changes reuse the same result.
            if not read_only:
                await connection.execute("INSERT INTO lms_storage_receipts(id,fingerprint,result) VALUES(?,?,?)", (request["requestId"], fingerprint, json.dumps(result, ensure_ascii=False)))
                await connection.execute("INSERT INTO lms_audit(actor,action,target) VALUES(?,?,?)", (request.get("actor", "discord-bot"), "bot-storage." + operation, request["guildId"]))
            await connection.commit()
            return result
        except BaseException:
            aiosqlite.connect = original_connect
            await connection.rollback()
            raise


def validate(operation, arguments, guild_id):
    from datetime import date
    for key, value in arguments.items():
        if value is None and key == "mentor_id" and operation == "get_all_bookings":
            continue
        if key in {"mentor_id", "slot_id", "booking_id", "assignment_id", "round_id", "panel_id"}:
            if type(value) is not int or value <= 0:
                raise ValueError("Invalid record ID")
        if key in {"user_id", "guild_id", "channel_id", "message_id", "discord_id", "thread_id", "evaluator_id", "target_id"}:
            if not isinstance(value, str) or not value.isdigit() or not 17 <= len(value) <= 20:
                raise ValueError("Invalid Discord ID")
        if key == "guild_id" and value != guild_id:
            raise ValueError("Guild mismatch")
        if isinstance(value, str) and len(value) > 20000:
            raise ValueError("Text too long")
        if key in {"name", "title", "user_name", "target_name", "label"} and (not isinstance(value, str) or not value.strip() or len(value) > 200):
            raise ValueError("Invalid name")
        if key == "active_only" and type(value) is not bool:
            raise ValueError("Invalid active flag")
        if key == "type_" and value not in {"team", "individual"}:
            raise ValueError("Invalid assignment type")
        if key == 'course_id' and value is not None and (not isinstance(value, str) or not value.strip() or len(value) > 200):
            raise ValueError('Invalid course')
        if key == "week" and (type(value) is not int or not 1 <= value <= 1000):
            raise ValueError("Invalid week")
        if key == "interval_minutes" and (type(value) is not int or not 5 <= value <= 1440):
            raise ValueError("Invalid interval")
        if key.endswith("_hour") and (type(value) is not int or not 0 <= value <= 23):
            raise ValueError("Invalid hour")
        if key.endswith("_minute") and (type(value) is not int or not 0 <= value <= 59):
            raise ValueError("Invalid minute")
        if key == "date":
            date.fromisoformat(value)
        if key == "weekdays" and (not isinstance(value, list) or len(value) > 7 or any(type(v) is not int or not 0 <= v <= 6 for v in value)):
            raise ValueError("Invalid weekdays")
        if key == "scores" and (len(value) != 4 or any(type(v) is not int or not 1 <= v <= 5 for v in value)):
            raise ValueError("Invalid evaluation scores")
        if key == "fields":
            fields = json.loads(value)
            if not isinstance(fields, list) or not 1 <= len(fields) <= 4 or any(not isinstance(v, str) or not v.strip() or len(v) > 45 for v in fields):
                raise ValueError("Invalid assignment fields")
    if operation == "generate_slots_for_range":
        for key in ("date_from", "date_to"):
            if isinstance(arguments[key], str):
                arguments[key] = date.fromisoformat(arguments[key])
        days = (arguments["date_to"] - arguments["date_from"]).days
        if not 0 <= days <= 92:
            raise ValueError("Date range must be within 93 days")
    if operation == "set_slot_template":
        if arguments["start_hour"] * 60 + arguments["start_minute"] >= arguments["end_hour"] * 60 + arguments["end_minute"]:
            raise ValueError("End time must follow start time")
    if operation == "add_slot":
        from datetime import datetime
        if datetime.fromisoformat(arguments["start_time"]) >= datetime.fromisoformat(arguments["end_time"]):
            raise ValueError("Invalid slot time")


async def respond(request, filename, schema=None):
    try:
        return {"ok": True, "result": await run(request, filename, schema)}
    except Exception as error:
        # Never echo private submissions, SQL parameters, or filesystem paths.
        code = str(error) if str(error) in {'stale_revision', 'assignment_course_required'} else 'invalid_operation'
        if isinstance(error, sqlite3.OperationalError) and getattr(error, "sqlite_errorcode", 0) & 255 in {sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED}:
            code = "storage_busy"
        if getattr(error, 'sqlstate', None) in {'55P03', '57014', '40001', '40P01'} or (getattr(error, 'sqlstate', None) or '').startswith('08'):
            code = "storage_busy"
        if schema:
            import psycopg
            if isinstance(error, (psycopg.OperationalError, psycopg.InterfaceError)):
                code = "storage_busy"
        return {"ok": False, "error": code, "type": type(error).__name__}


async def serve():
    # No concurrent requests in a process: legacy connection interception stays isolated.
    for line in sys.stdin:
        message = json.loads(line)
        response = await respond(message["request"], message.get("filename"), message.get("schema"))
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    if sys.argv[1] == "--serve":
        asyncio.run(serve())
    else:
        response = asyncio.run(respond(json.loads(sys.stdin.read()), sys.argv[1]))
        print(json.dumps(response, ensure_ascii=False))
        sys.exit(0 if response["ok"] else 1)
