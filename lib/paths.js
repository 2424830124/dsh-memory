/**
 * Where memory lives on disk.
 *
 * The layout is a plain value, resolved once from configuration and the
 * environment, so every path question — "which directory holds this scope",
 * "where is the session state" — is answered in one place and can be replaced
 * wholesale by a test or by a future storage backend.
 *
 * ```
 * <homeDir>/<dataDir>/<workspaceDirName>/*.yaml   Global memory files
 * <homeDir>/<dataDir>/state/sessions/*.json       per-session delivery snapshots
 * <workspaceRoot>/<workspaceDirName>/*.yaml       Workspace memory files
 * ```
 *
 * @module dsh-memory/paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Default Harness home directory name under the user's home. */
const DEFAULT_HOME_DIR = '.dsh'

/** Default plugin data directory under the Harness home. */
const DEFAULT_DATA_DIR = 'dsh-memory'

/** Default directory name for memory files, under both the data dir and a workspace. */
const DEFAULT_WORKSPACE_DIR = '.memory'

/**
 * The directory layout used by one store.
 * @typedef {object} MemoryLayout
 * @property {string} homeDir - the Harness home directory.
 * @property {string} dataDir - the plugin's private data directory.
 * @property {string} globalDir - the directory holding Global memory files.
 * @property {string} stateDir - the directory holding session snapshots.
 * @property {string} workspaceDirName - the memory directory name inside a workspace.
 * @property {(workspaceRoot: string) => string} workspaceDir - memory directory for one workspace.
 * @property {(scope: string, workspaceRoot: string) => string} directoryFor - directory for one scope.
 */

/**
 * Resolve the Harness home directory.
 * @param {string|undefined} configured - an explicit override.
 * @param {NodeJS.ProcessEnv} [env] - the environment to read `DSH_HOME` from.
 * @returns {string} the absolute home directory.
 */
function resolveHome(configured, env) {
  if (configured !== undefined && configured.trim() !== '') return resolve(configured)
  const fromEnv = env?.DSH_HOME
  if (fromEnv !== undefined && fromEnv.trim() !== '') return resolve(fromEnv)
  return join(homedir(), DEFAULT_HOME_DIR)
}

/**
 * Resolve the full directory layout.
 * @param {object} [options] - layout configuration.
 * @param {string} [options.homeDir] - Harness home override.
 * @param {string} [options.globalDir] - Global memory directory override.
 * @param {string} [options.workspaceDirName] - memory directory name inside a workspace.
 * @param {NodeJS.ProcessEnv} [options.env] - the environment to read `DSH_HOME` from.
 * @returns {MemoryLayout} the resolved layout.
 */
export function resolveLayout(options = {}) {
  const env = options.env ?? process.env
  const homeDir = resolveHome(options.homeDir, env)
  const dataDir = join(homeDir, DEFAULT_DATA_DIR)
  const globalDir = options.globalDir !== undefined && options.globalDir.trim() !== ''
    ? resolve(options.globalDir)
    : join(dataDir, DEFAULT_WORKSPACE_DIR)
  const workspaceDirName = options.workspaceDirName ?? DEFAULT_WORKSPACE_DIR

  const workspaceDir = (workspaceRoot) => join(workspaceRoot, workspaceDirName)

  return {
    homeDir,
    dataDir,
    globalDir,
    stateDir: join(dataDir, 'state'),
    workspaceDirName,
    workspaceDir,
    directoryFor: (scope, workspaceRoot) => (scope === 'Global' ? globalDir : workspaceDir(workspaceRoot)),
  }
}
