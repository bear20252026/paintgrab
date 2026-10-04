import { openSync, closeSync, fstatSync, readSync, constants } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

export const BACKEND_CONTRACT = 'game-backend-contract.json'
const MAX_BYTES = 16 * 1024
const invalid = () => { throw new Error('Game backend compatibility declaration is invalid') }
const object = (value, keys) => {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) invalid()
}
const positive = value => Number.isSafeInteger(value) && value > 0
const relative = value => typeof value === 'string' && value.length <= 256 && /^[A-Za-z0-9_./-]+$/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..')
const routePath = value => typeof value === 'string' && value.length <= 256 && /^\/\*$|^(?:\/\.*[A-Za-z0-9_~-][A-Za-z0-9._~-]*)+(?:\/\*)?$/.test(value)

export function parseBackendContract(value) {
  const auth = value?.schema === 'manus.game.auth-backend-contract/v1'
  object(value, ['schema', 'deploy', 'routes', 'api', 'database', ...(auth ? [] : ['boards'])])
  if (!auth && value.schema !== 'manus.game.backend-contract/v1') invalid()
  object(value.deploy, ['mode', 'dockerfilePath', 'healthPath'])
  if (value.deploy.mode !== 'hybrid' || !relative(value.deploy.dockerfilePath) || !routePath(value.deploy.healthPath) || value.deploy.healthPath.includes('*') || !value.deploy.healthPath.startsWith('/api/')) invalid()
  object(value.api, ['protocolVersion'])
  object(value.database, ['schemaVersion'])
  if (!positive(value.api.protocolVersion) || !positive(value.database.schemaVersion)) invalid()
  if (!Array.isArray(value.routes) || !value.routes.length || value.routes.length > 64) invalid()
  for (const route of value.routes) {
    object(route, ['path', 'target', 'cache', 'spaFallback'])
    if (!routePath(route.path) || !['server', 'static'].includes(route.target) ||
        (route.spaFallback !== undefined && typeof route.spaFallback !== 'boolean') ||
        (route.cache !== undefined && !['immutable', 'no-cache'].includes(route.cache) && !(Number.isSafeInteger(route.cache) && route.cache >= 0 && route.cache <= 31536000))) invalid()
    if (route.target === 'server' && (!route.path.startsWith('/api/') || route.cache !== undefined)) invalid()
  }
  if (value.routes.at(-1).path !== '/*' || value.routes.at(-1).target !== 'static' || !value.routes.some(route => route.path === '/api/*' && route.target === 'server')) invalid()
  // Auth-only games share the release binding, not the leaderboard schema/rules.
  // Keep the existing leaderboard contract strict, including its nonempty boards.
  if (auth) {
    if (value.api.protocolVersion !== 1 || value.database.schemaVersion !== 1) invalid()
    return value
  }
  if (!Array.isArray(value.boards) || !value.boards.length || value.boards.length > 64) invalid()
  const ids = new Set()
  for (const board of value.boards) {
    object(board, ['id', 'rulesVersion'])
    if (typeof board.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(board.id) || ids.has(board.id) || typeof board.rulesVersion !== 'string' || !/^[A-Za-z0-9_.-]{1,32}$/.test(board.rulesVersion)) invalid()
    ids.add(board.id)
  }
  return value
}

export function readBackendContract(root, { required = false } = {}) {
  let fd
  try { fd = openSync(join(root, BACKEND_CONTRACT), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK) }
  catch (error) { if (error.code === 'ENOENT' && !required) return null; invalid() }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) invalid()
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (!count) break
      length += count
    }
    if (length > MAX_BYTES) invalid()
    const content = bytes.subarray(0, length)
    return { value: parseBackendContract(JSON.parse(content.toString('utf8'))), sha256: 'sha256:' + createHash('sha256').update(content).digest('hex') }
  } catch { invalid() } finally { closeSync(fd) }
}

export function backendBindingMismatch(contract, binding) {
  if (binding?.deploy?.mode !== contract.deploy.mode) return 'deploy.mode'
  for (const key of ['dockerfilePath', 'healthPath']) if (binding.deploy[key] !== contract.deploy[key]) return `deploy.${key}`
  const shape = routes => routes?.map(route => [route.path, route.target, route.cache ?? null, route.spaFallback ?? null])
  if (JSON.stringify(shape(binding.routes)) !== JSON.stringify(shape(contract.routes))) return 'routes'
  return null
}
