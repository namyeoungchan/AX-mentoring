import { z } from 'zod';
import { ApiError } from './store.mjs';
import { studentEnrollment } from './student.mjs';
import { createVimeo, safeUploadUrl } from './vimeo.mjs';

const uploadInput = z.object({ requestId: z.uuid(), courseId: z.string().min(1).max(200), title: z.string().trim().min(1).max(150), description: z.string().trim().max(3000).default(''), filename: z.string().min(1).max(255), size: z.number().int().positive(), lastModified: z.number().int().nonnegative() }).strict();
const editInput = z.object({ revision: z.number().int().positive(), title: z.string().trim().min(1).max(150), description: z.string().trim().max(3000), published: z.boolean() }).strict();
const kind = 'course-video';

export function createCourseVideos(db, workspaces, env = {}, vimeo = createVimeo(env)) {
  const busy = new Set();
  const namespace = id => `workspace:${id}`;
  async function locked(key, fn) {
    if (busy.has(key)) throw new ApiError(409, '영상 작업 중입니다. 잠시 후 다시 확인하세요.');
    busy.add(key); try { return await fn(); } finally { busy.delete(key); }
  }
  async function context(id, user, writing = false) {
    const access = await workspaces.requireAccess(id, user);
    if (writing && access.archivedAt !== null) throw new ApiError(409, '보관된 워크스페이스입니다.');
    const manager = ['admin','instructor'].includes(access.role);
    if (writing && !manager) throw new ApiError(403, '멘토 또는 관리자만 영상을 관리할 수 있습니다.');
    let data;
    if (access.role === 'admin') data = await workspaces.snapshot(id);
    else if (manager) data = await workspaces.teaching(id, user);
    else {
      const { course } = await studentEnrollment((await workspaces.open(id)).db, user, access.discordVerified);
      data = { courses: course ? [course] : [] };
    }
    return { manager, admin: access.role === 'admin', courses: data.courses.map(c => ({ id: c.id, title: c.title })), archived: access.archivedAt !== null };
  }
  async function read(id, videoId) {
    const row = await db.prepare('SELECT data FROM lms_runtime_state WHERE guild_id=? AND kind=? AND record_key=?').get(namespace(id), kind, videoId);
    if (!row) throw new ApiError(404, '영상을 찾을 수 없습니다.');
    return JSON.parse(row.data);
  }
  async function save(id, before, changes) {
    const next = { ...before, ...changes, revision: before.revision + 1 };
    const result = await db.prepare('UPDATE lms_runtime_state SET data=? WHERE guild_id=? AND kind=? AND record_key=? AND data=?').run(JSON.stringify(next), namespace(id), kind, before.id, JSON.stringify(before));
    if (!result.changes) throw new ApiError(409, '영상 정보가 변경되었습니다. 새로고침하세요.');
    return next;
  }
  function authorize(c, video, user, writing = false) {
    if (!c.courses.some(course => course.id === video.courseId)) throw new ApiError(403, '해당 과정의 영상에 접근할 수 없습니다.');
    if (writing && !c.admin && video.ownerId !== user.id) throw new ApiError(403, '본인이 올린 영상만 변경할 수 있습니다.');
    if (!c.manager && (!video.published || video.status !== 'ready')) throw new ApiError(404, '게시된 영상을 찾을 수 없습니다.');
  }
  function summary(video, c, user) {
    return { id: video.id, courseId: video.courseId, title: video.title, description: video.description, status: video.status, published: video.published, duration: video.duration || 0, createdAt: video.createdAt, revision: video.revision,
      ...(c.manager ? { canEdit: !c.archived && (c.admin || video.ownerId === user.id), error: video.error || '', filename: video.filename, size: video.size, lastModified: video.lastModified } : {}) };
  }
  async function list(id, user) {
    const c = await context(id, user);
    const rows = (await db.prepare('SELECT data FROM lms_runtime_state WHERE guild_id=? AND kind=?').all(namespace(id), kind)).map(r => JSON.parse(r.data));
    return { courses: c.courses, canUpload: c.manager && !c.archived, configured: vimeo.configured, maxBytes: vimeo.maxBytes, videos: rows.filter(v => c.courses.some(course => course.id === v.courseId) && (c.manager || v.published && v.status === 'ready')).sort((a,b) => b.createdAt - a.createdAt).map(v => summary(v,c,user)) };
  }
  async function create(id, body, user) {
    const input = uploadInput.parse(body), c = await context(id, user, true);
    if (!c.courses.some(course => course.id === input.courseId)) throw new ApiError(403, '담당 과정을 선택하세요.');
    if (input.size > vimeo.maxBytes) throw new ApiError(413, '영상 파일이 업로드 용량 제한을 초과했습니다.');
    if (!/\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(input.filename)) throw new ApiError(422, 'MP4, MOV, M4V, WEBM, AVI, MKV 영상을 선택하세요.');
    return locked(`${id}:${input.requestId}`, async () => {
      const previous = await db.prepare('SELECT data FROM lms_runtime_state WHERE guild_id=? AND kind=? AND record_key=?').get(namespace(id), kind, input.requestId);
      if (previous) {
        const v = JSON.parse(previous.data); authorize(c,v,user,true);
        if (JSON.stringify(v.input) !== JSON.stringify(input)) throw new ApiError(409, '이미 사용한 업로드 요청 번호입니다.');
        return summary(v,c,user);
      }
      await vimeo.verify();
      let video = { id: input.requestId, ...input, input, ownerId: user.id, status: 'preparing', published: false, createdAt: Date.now(), revision: 1 };
      // Persist the request before the remote call; never repeat an uncertain POST.
      await db.prepare('INSERT INTO lms_runtime_state(guild_id,kind,record_key,data) VALUES(?,?,?,?)').run(namespace(id),kind,video.id,JSON.stringify(video));
      try {
        const remote = await vimeo.create(input);
        video = await save(id, video, { vimeoId: remote.id, uploadUrl: remote.uploadUrl });
        if (!safeUploadUrl(remote.uploadUrl)) throw new ApiError(502, 'Vimeo 업로드 주소를 확인하지 못했습니다.');
        await vimeo.protect(remote.id);
        video = await save(id, video, { status: 'uploading', error: '' });
      } catch (error) {
        video = await save(id, video, { status: 'error', error: error instanceof ApiError ? error.message : '영상 준비에 실패했습니다. 관리자에게 문의하세요.' });
      }
      return summary(video,c,user);
    });
  }
  async function upload(id, videoId, user) {
    const c = await context(id,user,true), v = await read(id,videoId); authorize(c,v,user,true);
    if (v.status !== 'uploading' || !safeUploadUrl(v.uploadUrl)) throw new ApiError(409, '이 영상의 업로드를 재개할 수 없습니다. 상태를 확인하세요.');
    return { uploadUrl: v.uploadUrl, size: v.size, filename: v.filename, lastModified: v.lastModified };
  }
  async function refresh(id, videoId, user) {
    return locked(`${id}:${videoId}`, async () => {
      const c = await context(id,user,true); let v = await read(id,videoId); authorize(c,v,user,true);
      if (!v.vimeoId) throw new ApiError(409, 'Vimeo에서 영상 생성 여부를 확인하세요. 확인 후 새 파일로 등록할 수 있습니다.');
      if (v.status === 'error') await vimeo.protect(v.vimeoId);
      const remote = await vimeo.read(v.vimeoId);
      const ready = remote.upload?.status === 'complete' && remote.transcode?.status === 'complete';
      const failed = remote.upload?.status === 'error' || remote.transcode?.status === 'error' || String(remote.status).startsWith('error');
      v = await save(id,v,{ status: failed ? 'error' : ready ? 'ready' : remote.upload?.status === 'complete' ? 'processing' : 'uploading', duration: remote.duration || 0, error: failed ? '영상 변환에 실패했습니다. 원본 파일을 확인하세요.' : '', ...(!ready ? { published: false } : {}) });
      return summary(v,c,user);
    });
  }
  async function edit(id, videoId, body, user) {
    const input = editInput.parse(body);
    return locked(`${id}:${videoId}`, async () => {
      const c = await context(id,user,true); let v = await read(id,videoId); authorize(c,v,user,true);
      if (v.revision !== input.revision) throw new ApiError(409, '영상 정보가 변경되었습니다. 새로고침하세요.');
      if (input.published) {
        if (v.status !== 'ready') throw new ApiError(409, '변환이 완료된 영상만 게시할 수 있습니다.');
        const remote = await vimeo.read(v.vimeoId);
        if (remote.transcode?.status !== 'complete' || remote.upload?.status !== 'complete') throw new ApiError(409, 'Vimeo의 영상 변환 상태를 다시 확인하세요.');
      }
      if (input.published !== v.published) await vimeo.publish(v.vimeoId,input.published);
      v = await save(id,v,{ title: input.title, description: input.description, published: input.published });
      return summary(v,c,user);
    });
  }
  async function playback(id, videoId, user) {
    const c = await context(id,user), v = await read(id,videoId); authorize(c,v,user);
    if (!v.published || v.status !== 'ready') throw new ApiError(409, '게시 후 영상을 재생할 수 있습니다.');
    if (!/^\d+$/.test(v.vimeoId)) throw new ApiError(409, '영상 연결을 확인하세요.');
    return { title: v.title, url: `https://player.vimeo.com/video/${v.vimeoId}?dnt=1&title=0&byline=0&portrait=0` };
  }
  return { list, create, upload, refresh, edit, playback };
}
