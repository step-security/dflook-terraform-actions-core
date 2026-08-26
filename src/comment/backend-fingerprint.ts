import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { BackendConfig } from './backend-config.js'

/**
 * Fingerprinting a backend configuration.
 *
 * Combined with the backend type and workspace name, this identifies one remote
 * state file. It goes into the pull request comment header so that a comment can
 * be matched to the configuration that produced it.
 *
 * Only the fields that say *which* state file is in use are included, not the
 * ones describing how it is reached. Two runs pointing at the same state must
 * fingerprint the same even if, say', one of them was given a different role to
 * assume; and two runs pointing at different state must never collide, or a plan
 * from one module could be treated as approving an apply in another.
 *
 * Each backend needs its own field list because there is no general rule for
 * which of its settings identify the state. The lists, and the environment
 * variables that stand in for missing values, match upstream so that a comment
 * written by either action is matched by the other.
 */

/** Reads the first of several environment variables that has a value. */
function fromEnv(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]
    if (value) return value
  }
  return ''
}

/** A config value, or the first environment variable standing in for it. */
function orEnv(
  config: BackendConfig,
  key: string,
  env: NodeJS.ProcessEnv,
  ...names: string[]
): string {
  return config[key] || fromEnv(env, ...names)
}

type Fingerprinter = (config: BackendConfig, env: NodeJS.ProcessEnv) => Record<string, unknown>

/** Sorts a space-separated list so ordering does not change the fingerprint. */
function sortedWords(value: string | undefined): string {
  if (!value) return ''
  return value.split(' ').sort().join(' ')
}

const remote: Fingerprinter = (config) => ({
  hostname: config.hostname ?? '',
  organization: config.organization ?? '',
  workspaces: config.workspaces ?? '',
})

const FINGERPRINTERS: Record<string, Fingerprinter> = {
  remote,
  cloud: remote,

  artifactory: (config, env) => ({
    url: orEnv(config, 'url', env, 'ARTIFACTORY_URL'),
    repo: config.repo ?? '',
    subpath: config.subpath ?? '',
  }),

  azurerm: (config, env) => ({
    storage_account_name: config.storage_account_name ?? '',
    container_name: config.container_name ?? '',
    key: config.key ?? '',
    environment: orEnv(config, 'environment', env, 'ARM_ENVIRONMENT'),
    endpoint: orEnv(config, 'endpoint', env, 'ARM_ENDPOINT'),
    resource_group_name: config.resource_group_name ?? '',
    msi_endpoint: orEnv(config, 'msi_endpoint', env, 'ARM_MSI_ENDPOINT'),
    subscription_id: orEnv(config, 'subscription_id', env, 'ARM_SUBSCRIPTION_ID'),
    tenant_id: orEnv(config, 'tenant_id', env, 'ARM_TENANT_ID'),
  }),

  consul: (config, env) => ({
    path: config.path ?? '',
    address: orEnv(config, 'address', env, 'CONSUL_HTTP_ADDR'),
  }),

  cos: (config) => ({
    bucket: config.bucket ?? '',
    prefix: config.prefix ?? '',
    key: config.key ?? '',
    region: config.region ?? '',
  }),

  etcd: (config) => ({
    path: config.path ?? '',
    endpoints: sortedWords(config.endpoints),
  }),

  etcd3: (config) => ({
    prefix: config.prefix ?? '',
    endpoints: sortedWords(config.endpoints),
  }),

  gcs: (config) => ({
    bucket: config.bucket ?? '',
    prefix: config.prefix ?? '',
  }),

  http: (config, env) => ({
    address: orEnv(config, 'address', env, 'TF_HTTP_ADDRESS'),
    lock_address: orEnv(config, 'lock_address', env, 'TF_HTTP_LOCK_ADDRESS'),
    unlock_address: orEnv(config, 'unlock_address', env, 'TF_HTTP_UNLOCK_ADDRESS'),
  }),

  kubernetes: (config, env) => ({
    secret_suffix: config.secret_suffix ?? '',
    namespace: orEnv(config, 'namespace', env, 'KUBE_NAMESPACE'),
    host: orEnv(config, 'host', env, 'KUBE_HOST'),
    config_path: orEnv(config, 'config_path', env, 'KUBE_CONFIG_PATH'),
    config_paths: orEnv(config, 'config_paths', env, 'KUBE_CONFIG_PATHS'),
    // Note the asymmetry: the config key is `context`, the header is
    // `config_context`. Upstream's, and renaming it would change the hash.
    config_context: orEnv(config, 'context', env, 'KUBE_CTX'),
    config_context_cluster: orEnv(config, 'config_context_cluster', env, 'KUBE_CTX_CLUSTER'),
  }),

  manta: (config, env) => ({
    account: orEnv(config, 'account', env, 'SDC_ACCOUNT', 'TRITON_ACCOUNT'),
    url: orEnv(config, 'url', env, 'MANTA_URL'),
    path: config.path ?? '',
    object_name: config.object_name ?? '',
  }),

  oss: (config, env) => ({
    region: orEnv(config, 'region', env, 'ALICLOUD_REGION', 'ALICLOUD_DEFAULT_REGION'),
    endpoint: orEnv(config, 'endpoint', env, 'ALICLOUD_OSS_ENDPOINT', 'OSS_ENDPOINT'),
    bucket: config.bucket ?? '',
    prefix: config.prefix ?? '',
    key: config.key ?? '',
  }),

  pg: (config) => ({
    conn_str: config.conn_str ?? '',
    schema_name: config.schema_name ?? '',
  }),

  s3: (config, env) => ({
    endpoint: orEnv(config, 'endpoint', env, 'AWS_S3_ENDPOINT'),
    bucket: config.bucket ?? '',
    workspace_key_prefix: config.workspace_key_prefix ?? '',
    key: config.key ?? '',
  }),

  swift: (config, env) => ({
    auth_url: orEnv(config, 'auth_url', env, 'OS_AUTH_URL'),
    cloud: orEnv(config, 'cloud', env, 'OS_CLOUD'),
    region_name: orEnv(config, 'region_name', env, 'OS_REGION_NAME'),
    container: config.container ?? '',
    state_name: config.state_name ?? '',
    path: config.path ?? '',
    tenant_id: orEnv(config, 'tenant_id', env, 'OS_TENANT_NAME', 'OS_PROJECT_NAME'),
    project_domain_name: orEnv(config, 'project_domain_name', env, 'OS_PROJECT_DOMAIN_NAME'),
    project_domain_id: orEnv(config, 'project_domain_id', env, 'OS_PROJECT_DOMAIN_ID'),
    // Alone among these, this has no empty-string fallback upstream, so it can
    // be null. A null and an empty string encode differently, so the
    // distinction has to survive.
    domain_name:
      config.domain_name ||
      env.OS_USER_DOMAIN_NAME ||
      env.OS_PROJECT_DOMAIN_NAME ||
      env.OS_DOMAIN_NAME ||
      env.DEFAULT_DOMAIN ||
      null,
    domain_id: orEnv(config, 'domain_id', env, 'OS_PROJECT_DOMAIN_ID'),
    default_domain: orEnv(config, 'default_domain', env, 'OS_DEFAULT_DOMAIN'),
  }),
}

/** `local` needs the module path, which is not part of the backend config. */
function fingerprintLocal(config: BackendConfig, modulePath: string): Record<string, unknown> {
  const inputs: Record<string, unknown> = { path: config.path ?? modulePath }
  if ('workspace_dir' in config) inputs.workspace_dir = config.workspace_dir
  return inputs
}

/**
 * Encodes a value as canonical JSON.
 *
 * Keys sorted, no whitespace. This has to agree with Python's `canonicaljson`
 * exactly, since the bytes are hashed: any difference in key order or spacing
 * produces a different fingerprint and stops comments matching. Sorting is by
 * code unit, which agrees with the byte order Python uses for the ASCII keys
 * used here.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

export interface FingerprintOptions {
  backendType: string
  config: BackendConfig
  env?: NodeJS.ProcessEnv
  /** Module directory, needed for the `local` backend. */
  modulePath: string
  /** Terraform data directory, read for the initialised config. */
  dataDir?: string
}

/**
 * Overlays values recorded in the initialised backend.
 *
 * Terraform writes the backend it actually initialised into its data directory.
 * Where that disagrees with the configuration, the initialised value is what is
 * really in use, so it wins. Without this a partial config completed at `init`
 * time would fingerprint differently from the same backend after
 * initialisation.
 */
function withInitialisedConfig(
  backendType: string,
  fields: Record<string, unknown>,
  dataDir: string | undefined
): Record<string, unknown> {
  if (!dataDir) return fields

  const statePath = join(dataDir, 'terraform.tfstate')
  if (!existsSync(statePath)) return fields

  let backend: { type?: string; config?: Record<string, unknown> } | undefined
  try {
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      backend?: { type?: string; config?: Record<string, unknown> }
    }
    backend = state.backend
  } catch {
    // An unreadable state file is not a reason to fail; the configuration is
    // still a usable fingerprint.
    return fields
  }

  if (!backend?.config || backend.type !== backendType) return fields

  const merged = { ...fields }
  for (const key of Object.keys(merged)) {
    const value = backend.config[key]
    if (value !== undefined && value !== null && value !== merged[key]) {
      merged[key] = value
    }
  }
  return merged
}

/**
 * The fingerprint bytes for a backend configuration.
 *
 * An unrecognised backend type falls back to the whole config, which is
 * conservative in the right direction: it may change more often than necessary,
 * causing a new comment rather than a wrong match.
 */
export function backendFingerprint(options: FingerprintOptions): string {
  const env = options.env ?? process.env

  const fields =
    options.backendType === 'local' || options.backendType === ''
      ? fingerprintLocal(options.config, options.modulePath)
      : (FINGERPRINTERS[options.backendType] ?? ((config) => config))(options.config, env)

  return canonicalJson(withInitialisedConfig(options.backendType, fields, options.dataDir))
}
