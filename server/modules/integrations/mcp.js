// G-03 MCP: AI 도구(Claude Code·Cursor·Claude Desktop 등)가 Streamable HTTP(무상태)로 미믹 드라이브를 다룬다.
// 인증은 Bearer 토큰(설정에서 만든 appId 'mcp' 토큰), 도구마다 필요한 권한(G-05)을 검사한다.
// ponytail: MCP OAuth(보호 리소스 메타데이터·동적 클라이언트 등록)는 없다. OAuth 만 받는 웹 커넥터(ChatGPT·claude.ai 웹)는 연결할 수 없고
// 설정 화면에 그렇게 안내한다. 붙이려면 /.well-known/oauth-protected-resource·인가·토큰 엔드포인트를 만들어 appId 'mcp' 토큰으로 발급
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { requireUser, hasScope, readToken } from '../../core/auth.js';
import { fail } from '../../core/util.js';
import { toApi, requireNode, listChildren, createFolder, pathOf } from '../../core/files.js';
import { summary } from '../../core/quota.js';
import { userSession, issueKey, parseScopes, callApi } from './index.js';

const MCP_PATH = '/api/integrations/mcp';
const brief = (n) => ({ id: n.id, name: n.name, kind: n.kind, size: n.size, mime: n.mime, parentId: n.parent_id, updatedAt: new Date(n.updated_at).toISOString() });

function buildServer(ctx, req) {
  const { db } = ctx;
  const uid = req.user.id;
  const token = readToken(req);
  const server = new McpServer({ name: 'mimic', version: '0.1.0' });
  // scopes: 도구가 부르는 API 가 요구하는 권한을 모두 적는다
  const tool = (name, scopes, description, inputSchema, fn) =>
    server.registerTool(name, { description, inputSchema }, async (args) => {
      const missing = [scopes].flat().filter((sc) => !hasScope(req, sc));
      if (missing.length) return { isError: true, content: [{ type: 'text', text: `이 연결에는 ${missing.join(', ')} 권한이 없습니다. 미믹 설정에서 권한을 바꿔 다시 연결하세요.` }] };
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await fn(args || {}), null, 2) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message || '요청을 처리하지 못했습니다' }] };
      }
    });

  tool('list_files', 'files:read', '폴더 안의 파일·폴더 목록. folderId 를 비우면 최상위(모든 파일)', { folderId: z.string().optional() }, ({ folderId }) => {
    if (folderId) requireNode(db, uid, folderId, { kind: 'folder', space: 'drive' });
    return { path: pathOf(db, uid, folderId || null), items: listChildren(db, uid, folderId || null).map(brief) };
  });
  tool('search_files', 'files:read', '이름으로 파일·폴더 검색(휴지통 제외)', { query: z.string().min(1), limit: z.number().int().min(1).max(200).optional() }, ({ query, limit = 50 }) => {
    const like = `%${query.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const rows = db
      .prepare("SELECT * FROM files WHERE user_id=? AND space='drive' AND trashed_at IS NULL AND name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?")
      .all(uid, like, limit);
    return { items: rows.map(brief) };
  });
  tool('get_file_info', 'files:read', '파일·폴더 하나의 자세한 정보와 위치', { fileId: z.string() }, ({ fileId }) => {
    const n = requireNode(db, uid, fileId, { space: 'drive' });
    return { file: toApi(n), path: pathOf(db, uid, n.parent_id) };
  });
  tool('create_folder', 'files:write', '새 폴더 만들기. parentId 를 비우면 최상위', { name: z.string().min(1).max(255), parentId: z.string().optional() }, ({ name, parentId }) =>
    brief(createFolder(db, uid, parentId || null, name)),
  );
  // 이름 바꾸기·옮기기·휴지통은 drive API 를 그대로 불러 웹과 같은 규칙(이름 중복·하위 폴더 함께 휴지통)을 따른다
  const ids = z.array(z.string()).min(1).max(500);
  tool('rename_file', 'files:write', '파일·폴더 이름 바꾸기', { fileId: z.string(), name: z.string().min(1).max(255) }, ({ fileId, name }) =>
    callApi(ctx, token, 'PATCH', `/api/drive/files/${encodeURIComponent(fileId)}`, { name }),
  );
  tool('move_files', 'files:write', '파일·폴더를 다른 폴더로 옮기기. parentId 를 비우면 최상위', { fileIds: ids, parentId: z.string().optional() }, ({ fileIds, parentId }) =>
    callApi(ctx, token, 'POST', '/api/drive/move', { ids: fileIds, parentId: parentId || null }),
  );
  tool('trash_files', 'files:manage', '파일·폴더를 휴지통으로 옮기기(영구삭제 아님, 15일 안에 복원 가능)', { fileIds: ids }, ({ fileIds }) => callApi(ctx, token, 'POST', '/api/drive/trash', { ids: fileIds }));
  tool('restore_files', 'files:manage', '휴지통의 파일·폴더를 원래 자리로 되살리기', { fileIds: ids }, ({ fileIds }) => callApi(ctx, token, 'POST', '/api/drive/restore', { ids: fileIds }));
  // G-05: 서비스 권한 = 클라우드 다운로드·공유(offline API 도 services 만 요구)
  tool(
    'add_cloud_download',
    'services',
    '링크(마그넷·HTTP URL·SNS 게시물)를 미믹 서버가 대신 받아 드라이브에 저장하는 클라우드 다운로드 작업 만들기',
    { urls: z.array(z.string().min(1)).min(1).max(50), parentId: z.string().optional() },
    ({ urls, parentId }) => callApi(ctx, token, 'POST', '/api/offline/tasks', { urls, parentId: parentId || null }),
  );
  tool('list_tasks', 'services', '클라우드 다운로드 작업 목록과 진행 상태', {}, () => callApi(ctx, token, 'GET', '/api/offline/tasks'));
  tool(
    'create_share_link',
    'services',
    '파일·폴더 공유 링크 만들기. expiryDays: 0(영구)·7·14·30, password: true 면 비밀번호 자동 생성',
    { fileIds: z.array(z.string()).min(1).max(500), expiryDays: z.number().int().optional(), password: z.boolean().optional() },
    async (args) => {
      const r = await callApi(ctx, token, 'POST', '/api/share', args);
      return { ...r, url: r.url?.startsWith('/') ? ctx.cfg.baseUrl + r.url : r.url };
    },
  );
  tool('get_quota', 'files:read', '이번 달 전송 쿼터와 오늘 남은 클라우드 다운로드 횟수', {}, () => summary(db, req.user));
  return server;
}

// MCP 는 설정에서 만든 MCP 연결 토큰으로만 쓴다. 연결 앱 목록에서 끊으면 바로 막힌다(세션·다른 토큰은 받지 않음)
function requireMcpToken(req, res, next) {
  requireUser(req, res, () => {
    if (req.authKind !== 'token' || req.appId !== 'mcp') fail(403, 'mcp_token_required', '설정 > 액세스 및 통합의 AI 도구 연결에서 만든 MCP 토큰으로만 쓸 수 있습니다');
    next();
  });
}

export function registerMcp(app, ctx) {
  app.post(MCP_PATH, requireMcpToken, async (req, res) => {
    const server = buildServer(ctx, req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  // 무상태 서버라 SSE 스트림(GET)·세션 종료(DELETE)는 없다
  app.all(MCP_PATH, (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }));

  // 설정 화면의 "연결": MCP 전용 토큰과 AI 도구에 붙일 설정
  app.post('/api/integrations/mcp/connect', userSession, (req, res) => {
    const { client = 'AI 도구' } = req.body || {};
    const label = String(client).trim().slice(0, 40) || 'AI 도구';
    const scopes = parseScopes(req.body?.scopes, ['files:write', 'services']);
    const k = issueKey(ctx, req, { name: label, scopes, appId: 'mcp', days: 365 });
    const endpoint = ctx.cfg.baseUrl + MCP_PATH; // Host 헤더가 아닌 설정 주소
    const headers = { Authorization: `Bearer ${k.token}` };
    res.status(201).json({
      id: k.id,
      token: k.token,
      endpoint,
      scopes,
      expiresAt: k.expiresAt,
      config: { mcpServers: { mimic: { type: 'http', url: endpoint, headers } } },
      // Claude Desktop(Windows)·Cursor 는 args 안의 공백을 이스케이프하지 않으므로 공백 없는 헤더 + env 로 넘긴다(mcp-remote 권장 형식)
      claudeDesktop: { mcpServers: { mimic: { command: 'npx', args: ['-y', 'mcp-remote', endpoint, '--header', 'Authorization:${AUTH_HEADER}'], env: { AUTH_HEADER: `Bearer ${k.token}` } } } },
      claudeCode: `claude mcp add --transport http mimic ${endpoint} --header "Authorization: Bearer ${k.token}"`,
    });
  });
}
