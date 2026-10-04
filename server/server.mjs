import { readBackendContract } from './backend-contract.mjs';
import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { createRequestDatabase, databaseStream, DATABASE_CONCURRENCY } from './request-database.mjs';
import { previousSubmission, assertClientRules, assertRunRules, assertDatabaseEnvironment, assertDatabaseReady, databaseName, PROTOCOL_VERSION, SCHEMA_VERSION } from './deployment-contract.mjs';
import { cleanDisplayName, utcDay, validateSubmission } from './validate.mjs';
// This server belongs to the Paint Grab game project, never to Addon Server.
const backendContract = readBackendContract(process.cwd(), { required: true }).value;
if (backendContract.api.protocolVersion !== PROTOCOL_VERSION || backendContract.database.schemaVersion !== SCHEMA_VERSION || backendContract.deploy.healthPath !== '/api/leaderboards/v1/health') throw new Error('backend_contract_incompatible');
const namespace = 'production';
const readonly = process.env.GAME_LEADERBOARD_READ_ONLY === '1';
if (!process.env.DATABASE_URL) throw new Error('Project DATABASE_URL is required');
databaseName(process.env.DATABASE_URL);
const pool = mysql.createPool({ uri: process.env.DATABASE_URL, stream: databaseStream(process.env.DATABASE_URL), connectionLimit: DATABASE_CONCURRENCY, waitForConnections: false, connectTimeout: 3000, timezone: 'Z', dateStrings: true });
const db = createRequestDatabase(pool);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const uuidPattern = /^[0-9a-f-]{36}$/;
const prefix = '/api/leaderboards/v1';
const send = (res, status, data) => {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};
async function rateLimit(key, maximum) {
  const bucket = digest(key);
  const window = Math.floor(Date.now() / 60_000);
  const count = await db.transaction(async (conn) => {
    await conn.execute('INSERT IGNORE INTO game_lb_rate_limits (namespace,bucket_hash,window_start,request_count) VALUES (?, ?, ?, 0)', [namespace, bucket, window]);
    const [[row]] = await conn.execute('SELECT window_start, request_count FROM game_lb_rate_limits WHERE namespace=? AND bucket_hash=? FOR UPDATE', [namespace, bucket]);
    const next = Number(row.window_start) === window ? Math.min(Number(row.request_count) + 1, 4294967295) : 1;
    await conn.execute('UPDATE game_lb_rate_limits SET window_start=?, request_count=? WHERE namespace=? AND bucket_hash=?', [window, next, namespace, bucket]);
    return next;
  });
  if (count > maximum) fail(429, 'rate_limited');
}
async function body(req, keys) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'json_required');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2048) fail(413, 'body_too_large');
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'invalid_json'); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some((key) => !keys.includes(key))) fail(400, 'invalid_fields');
  return value;
}
async function identity(req, required = true) {
  const auth = req.headers.authorization || '';
  if (!auth && !required) return null;
  if (!/^Bearer [A-Za-z0-9_-]{43}$/.test(auth)) fail(401, 'guest_session_required');
  const [[player]] = await db.execute('SELECT id, display_name FROM game_lb_players WHERE namespace=? AND token_hash=? AND expires_at>UTC_TIMESTAMP(3)', [namespace, digest(auth.slice(7))]);
  if (!player) fail(401, 'guest_session_expired');
  await rateLimit(`player:${player.id}`, 120);
  return player;
}
async function board(conn, id) {
  const [[value]] = await conn.execute('SELECT * FROM game_lb_boards WHERE namespace=? AND id=?', [namespace, id]);
  if (!value) fail(404, 'board_not_found');
  if (!['asc', 'desc'].includes(value.direction) || !value.rules_version || Number(value.min_score) < -1e9 || Number(value.max_score) > 1e9 || Number(value.min_score) > Number(value.max_score)) fail(503, 'board_configuration_invalid');
  return value;
}
/** Where a score stands among other players' bests on one table (all-time or one UTC day). */
async function standing(table, boardId, day, playerId, rankValue) {
  const dayClause = day ? ' AND day=?' : '';
  const base = [namespace, boardId, ...(day ? [day] : [])];
  const [[row]] = await db.execute(
    `SELECT SUM(rank_value<?) AS better, SUM(rank_value>?) AS beaten, COUNT(*) AS others FROM ${table} WHERE namespace=? AND board_id=?${dayClause} AND player_id<>?`,
    [rankValue, rankValue, ...base, playerId],
  );
  const others = Number(row.others || 0);
  const beaten = Number(row.beaten || 0);
  return { rank: Number(row.better || 0) + 1, players: others + 1, beatPercent: others === 0 ? 100 : Math.floor((beaten * 100) / others) };
}
async function readBoard(boardId, day, limit, player) {
  const table = day ? 'game_lb_daily_best' : 'game_lb_best';
  const dayClause = day ? ' AND b.day=?' : '';
  const args = [namespace, boardId, ...(day ? [day] : [])];
  const [entries] = await db.query(
    `SELECT b.player_id AS playerId,p.display_name AS displayName,b.score,b.achieved_at AS achievedAt,r.territory_bp AS territoryBp,r.kills AS kills FROM ${table} b JOIN game_lb_players p ON p.namespace=b.namespace AND p.id=b.player_id LEFT JOIN game_lb_runs r ON r.namespace=b.namespace AND r.id=b.run_id WHERE b.namespace=? AND b.board_id=?${dayClause} ORDER BY b.rank_value,b.achieved_at,b.player_id LIMIT ?`,
    [...args, limit],
  );
  const [[count]] = await db.execute(`SELECT COUNT(*) AS n FROM ${table} b WHERE b.namespace=? AND b.board_id=?${dayClause}`, args);
  let myRank = null;
  if (player) {
    const [[own]] = await db.execute(`SELECT * FROM ${table} b WHERE b.namespace=? AND b.board_id=?${dayClause} AND b.player_id=?`, [...args, player.id]);
    if (own) {
      const [[rank]] = await db.execute(`SELECT COUNT(*)+1 AS ordinal FROM ${table} b WHERE b.namespace=? AND b.board_id=?${dayClause} AND (b.rank_value<? OR (b.rank_value=? AND (b.achieved_at<? OR (b.achieved_at=? AND b.player_id<?))))`, [...args, own.rank_value, own.rank_value, own.achieved_at, own.achieved_at, player.id]);
      myRank = { rank: Number(rank.ordinal), score: Number(own.score) };
    }
  }
  return {
    total: Number(count.n),
    myRank,
    entries: entries.map((e, i) => ({ displayName: e.displayName, score: Number(e.score), territoryBp: e.territoryBp == null ? null : Number(e.territoryBp), kills: e.kills == null ? null : Number(e.kills), achievedAt: e.achievedAt, rank: i + 1, isMe: !!player && e.playerId === player.id })),
  };
}
async function upsertBest(conn, table, keyCols, keyVals, score, rankValue, runId) {
  const where = keyCols.map((c) => `${c}=?`).join(' AND ');
  const [[best]] = await conn.execute(`SELECT rank_value FROM ${table} WHERE ${where} FOR UPDATE`, keyVals);
  if (!best) {
    await conn.execute(`INSERT INTO ${table} (${keyCols.join(',')},score,rank_value,achieved_at,run_id) VALUES (${keyCols.map(() => '?').join(',')},?,?,UTC_TIMESTAMP(3),?)`, [...keyVals, score, rankValue, runId]);
    return true;
  }
  if (rankValue < Number(best.rank_value)) {
    await conn.execute(`UPDATE ${table} SET score=?,rank_value=?,achieved_at=UTC_TIMESTAMP(3),run_id=? WHERE ${where}`, [score, rankValue, runId, ...keyVals]);
    return true;
  }
  return false;
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://game-api');
  if (!url.pathname.startsWith(`${prefix}/`)) fail(404, 'not_found');
  if (req.headers['sec-fetch-site'] === 'cross-site') fail(403, 'cross_origin_request');
  if (url.pathname === `${prefix}/health` && req.method === 'GET') {
    await assertDatabaseReady(db, namespace, backendContract);
    return send(res, 200, { status: 'ok', namespace, readonly, protocolVersion: PROTOCOL_VERSION, schemaVersion: SCHEMA_VERSION });
  }
  await assertDatabaseEnvironment(db, namespace);
  if (readonly && req.method !== 'GET') fail(403, 'leaderboard_read_only');
  if (req.method === 'POST' && url.pathname === `${prefix}/guests`) {
    await rateLimit('global:guests', 300);
    const data = await body(req, ['displayName']);
    const name = cleanDisplayName(data.displayName);
    if (!name) fail(400, 'invalid_display_name');
    const token = randomBytes(32).toString('base64url');
    const playerId = randomUUID();
    await db.execute('INSERT INTO game_lb_players (namespace,id,display_name,token_hash,expires_at) VALUES (?, ?, ?, ?, DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY))', [namespace, playerId, name, digest(token)]);
    return send(res, 201, { playerId, token, displayName: name, expiresInSeconds: 2592000 });
  }
  if (req.method === 'PATCH' && url.pathname === `${prefix}/guests/me`) {
    const player = await identity(req);
    const data = await body(req, ['displayName']);
    const name = cleanDisplayName(data.displayName);
    if (!name) fail(400, 'invalid_display_name');
    await db.execute('UPDATE game_lb_players SET display_name=?, expires_at=DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 30 DAY) WHERE namespace=? AND id=?', [name, namespace, player.id]);
    return send(res, 200, { playerId: player.id, displayName: name });
  }
  const route = url.pathname.slice(prefix.length).split('/').filter(Boolean);
  if (req.method === 'GET' && route.length === 2 && route[0] === 'challenges' && uuidPattern.test(route[1])) {
    await rateLimit('global:challenges', 3000);
    const [[run]] = await db.execute('SELECT r.id,r.score,r.territory_bp,r.kills,r.run_day,p.display_name FROM game_lb_runs r JOIN game_lb_players p ON p.namespace=r.namespace AND p.id=r.player_id WHERE r.namespace=? AND r.id=? AND r.submitted_at IS NOT NULL', [namespace, route[1]]);
    if (!run) fail(404, 'challenge_not_found');
    return send(res, 200, { runId: run.id, displayName: run.display_name, score: Number(run.score), territoryBp: run.territory_bp == null ? null : Number(run.territory_bp), kills: run.kills == null ? null : Number(run.kills), day: run.run_day });
  }
  if (route[0] === 'boards' && idPattern.test(route[1] || '')) {
    const boardId = route[1];
    if (req.method === 'GET' && route.length === 2) {
      const rules = await board(db, boardId);
      const limit = Number(url.searchParams.get('limit') || 20);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_limit');
      const period = url.searchParams.get('period') || 'all';
      if (!['all', 'today'].includes(period)) fail(400, 'invalid_period');
      const player = await identity(req, false);
      const day = utcDay();
      const result = await readBoard(boardId, period === 'today' ? day : null, limit, player);
      return send(res, 200, { namespace, boardId, period, day, rulesVersion: rules.rules_version, trust: 'server_checked', ...result });
    }
    if (req.method === 'POST' && route.length === 3 && route[2] === 'runs') {
      const player = await identity(req);
      const data = await body(req, ['releaseSha', 'protocolVersion', 'rulesVersion']);
      if (data.releaseSha !== undefined && (typeof data.releaseSha !== 'string' || !/^[a-f0-9]{7,64}$/.test(data.releaseSha))) fail(400, 'invalid_release_sha');
      const rules = await board(db, boardId);
      if (!rules.open) fail(409, 'board_closed');
      assertClientRules(data, rules);
      const runId = randomUUID();
      const day = utcDay();
      await db.execute('INSERT INTO game_lb_runs (namespace,id,player_id,board_id,issued_at,expires_at,release_sha,rules_version,protocol_version,run_day) VALUES (?,?,?,?,UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 30 MINUTE),?,?,?,?)', [namespace, runId, player.id, boardId, data.releaseSha ?? null, rules.rules_version, PROTOCOL_VERSION, day]);
      return send(res, 201, { runId, day, expiresInSeconds: 1800, rulesVersion: rules.rules_version, protocolVersion: PROTOCOL_VERSION });
    }
  }
  if (req.method === 'PUT' && route.length === 2 && route[0] === 'runs' && uuidPattern.test(route[1])) {
    const player = await identity(req);
    const data = await body(req, ['score', 'durationMs', 'territoryBp', 'kills', 'comboBonus', 'captures', 'survived']);
    if (!Number.isSafeInteger(data.score) || !Number.isSafeInteger(data.durationMs)) fail(400, 'invalid_score');
    const submissionHash = digest(JSON.stringify([data.score, data.durationMs, data.territoryBp, data.kills, data.comboBonus, data.captures, data.survived]));
    const receipt = await db.transaction(async (conn) => {
      // A player-level lock serializes simultaneous runs before any best row exists.
      await conn.execute('SELECT id FROM game_lb_players WHERE namespace=? AND id=? FOR UPDATE', [namespace, player.id]);
      const [[run]] = await conn.execute('SELECT *, expires_at<UTC_TIMESTAMP(3) AS expired, TIMESTAMPDIFF(MICROSECOND,issued_at,UTC_TIMESTAMP(3))/1000 AS elapsed FROM game_lb_runs WHERE namespace=? AND id=? AND player_id=? FOR UPDATE', [namespace, route[1], player.id]);
      const previous = previousSubmission(run, namespace, player.id, submissionHash);
      if (previous) return { ...previous, boardId: run.board_id, day: run.run_day, replay: true };
      const rules = await board(conn, run.board_id);
      if (!rules.open) fail(409, 'board_closed');
      assertRunRules(run, rules);
      validateSubmission(data, Number(run.elapsed));
      if (data.score < Number(rules.min_score) || data.score > Number(rules.max_score) || data.durationMs < Number(rules.min_duration_ms) || data.durationMs > Number(rules.max_duration_ms)) fail(422, 'score_outside_rules');
      const rankValue = rules.direction === 'desc' ? -data.score : data.score;
      const day = run.run_day || utcDay();
      const bestAll = await upsertBest(conn, 'game_lb_best', ['namespace', 'board_id', 'player_id'], [namespace, run.board_id, player.id], data.score, rankValue, run.id);
      const bestToday = await upsertBest(conn, 'game_lb_daily_best', ['namespace', 'board_id', 'day', 'player_id'], [namespace, run.board_id, day, player.id], data.score, rankValue, run.id);
      await conn.execute('UPDATE game_lb_runs SET score=?,duration_ms=?,territory_bp=?,kills=?,combo_bonus=?,captures=?,survived=?,submission_hash=?,submitted_at=UTC_TIMESTAMP(3) WHERE namespace=? AND id=?', [data.score, data.durationMs, data.territoryBp, data.kills, data.comboBonus, data.captures, data.survived, submissionHash, namespace, run.id]);
      return { runId: run.id, score: data.score, accepted: true, trust: 'server_checked', boardId: run.board_id, day, personalBest: bestAll, dailyBest: bestToday };
    });
    const rankValue = -receipt.score;
    const all = await standing('game_lb_best', receipt.boardId, null, player.id, rankValue);
    const today = await standing('game_lb_daily_best', receipt.boardId, receipt.day, player.id, rankValue);
    return send(res, 200, { ...receipt, all, today });
  }
  fail(404, 'not_found');
}
const server = http.createServer((req, res) => {
  db.run(req, res, () => handle(req, res)).catch((error) => {
    if (res.destroyed || res.writableEnded) return;
    send(res, error.status || 503, { error: error.code && error.status ? error.code : 'leaderboard_unavailable' });
    if (!req.complete) res.once('finish', () => req.destroy());
  });
});
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0', () => {
  const address = server.address();
  if (typeof address === 'object') process.send?.({ type: 'ready', port: address.port });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => pool.end().finally(() => process.exit(0))));
