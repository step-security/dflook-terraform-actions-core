import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Credentials Terraform needs to reach private module sources and Terraform
 * Cloud.
 *
 * Three inputs, each written where Terraform or git already looks for it:
 *
 * - `TERRAFORM_CLOUD_TOKENS` becomes `credentials` blocks in `.terraformrc`
 * - `TERRAFORM_HTTP_CREDENTIALS` becomes `.netrc` entries, which is how git
 *   authenticates HTTPS module sources
 * - `TERRAFORM_SSH_KEY` becomes an SSH private key, for git+ssh sources
 *
 * Existing files are appended to rather than replaced. A workflow may well have
 * set up its own credentials before this runs, and clobbering them would break
 * module sources that were previously working.
 */

export interface CredentialInputs {
  /** Newline- or comma-separated `hostname=token` pairs. */
  cloudTokens?: string
  /** Newline-separated `hostname=username:password` entries. */
  httpCredentials?: string
  /** A private key, written with owner-only permissions. */
  sshKey?: string
}

export interface CredentialTarget {
  /** Where `.terraformrc` and `.netrc` live. Defaults to the home directory. */
  home?: string
}

export interface WrittenCredentials {
  /** Hostnames a Terraform Cloud token was written for. */
  cloudHosts: string[]
  /** Hostnames a netrc entry was written for. */
  netrcHosts: string[]
  sshKeyWritten: boolean
}

/** Splits on newlines or commas, dropping blanks. */
function entries(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Renders `credentials` blocks for a Terraform CLI config.
 *
 * Each entry is `hostname=token`. The token may itself contain `=` — base64
 * padding, for instance — so only the first separator is significant.
 */
export function formatCloudTokens(value: string): { host: string; token: string }[] {
  const credentials: { host: string; token: string }[] = []

  for (const entry of entries(value)) {
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      throw new Error(`TERRAFORM_CLOUD_TOKENS entries must be "<hostname>=<token>", got '${entry}'`)
    }

    credentials.push({
      host: entry.slice(0, separator).trim(),
      token: entry.slice(separator + 1).trim(),
    })
  }

  return credentials
}

/**
 * Parses HTTP credentials.
 *
 * Each entry is `hostname=username:password`, where the hostname may include a
 * path prefix so different repositories on one host can use different
 * credentials. The password may contain colons, so only the first is a
 * separator.
 */
export function formatHttpCredentials(
  value: string
): { host: string; username: string; password: string }[] {
  const credentials: { host: string; username: string; password: string }[] = []

  for (const entry of entries(value)) {
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      throw new Error(
        `TERRAFORM_HTTP_CREDENTIALS entries must be "<hostname>=<username>:<password>", got '${entry}'`
      )
    }

    const host = entry.slice(0, separator).trim()
    const userAndPassword = entry.slice(separator + 1).trim()
    const colon = userAndPassword.indexOf(':')

    if (colon <= 0) {
      throw new Error(
        `TERRAFORM_HTTP_CREDENTIALS entries must be "<hostname>=<username>:<password>", got '${entry}'`
      )
    }

    credentials.push({
      host,
      username: userAndPassword.slice(0, colon),
      password: userAndPassword.slice(colon + 1),
    })
  }

  return credentials
}

/** Renders a `.terraformrc` credentials block. */
export function renderTerraformrc(credentials: { host: string; token: string }[]): string {
  return credentials
    .map(({ host, token }) => `credentials "${host}" {\n  token = "${token}"\n}\n`)
    .join('')
}

/**
 * Renders `.netrc` machine entries.
 *
 * A host given with a path prefix is reduced to its hostname, since netrc keys
 * on host alone.
 */
export function renderNetrc(
  credentials: { host: string; username: string; password: string }[]
): string {
  return credentials
    .map(({ host, username, password }) => {
      const hostname = host.split('/')[0]
      return `machine ${hostname}\nlogin ${username}\npassword ${password}\n`
    })
    .join('')
}

/**
 * Writes every supplied credential to disk.
 *
 * Files are created with restrictive permissions before anything is written to
 * them, so a secret is never briefly world-readable.
 */
export function writeCredentials(
  inputs: CredentialInputs,
  target: CredentialTarget = {}
): WrittenCredentials {
  const home = target.home ?? homedir()
  const written: WrittenCredentials = { cloudHosts: [], netrcHosts: [], sshKeyWritten: false }

  if (inputs.cloudTokens?.trim()) {
    const credentials = formatCloudTokens(inputs.cloudTokens)
    const path = join(home, '.terraformrc')

    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 })
    chmodSync(path, 0o600)
    appendFileSync(path, renderTerraformrc(credentials))

    written.cloudHosts = credentials.map((entry) => entry.host)
  }

  if (inputs.httpCredentials?.trim()) {
    const credentials = formatHttpCredentials(inputs.httpCredentials)
    const path = join(home, '.netrc')

    if (!existsSync(path)) writeFileSync(path, '', { mode: 0o600 })
    chmodSync(path, 0o600)
    appendFileSync(path, renderNetrc(credentials))

    written.netrcHosts = credentials.map((entry) => entry.host.split('/')[0])
  }

  if (inputs.sshKey?.trim()) {
    const sshDir = join(home, '.ssh')
    mkdirSync(sshDir, { recursive: true, mode: 0o700 })
    chmodSync(sshDir, 0o700)

    const keyPath = join(sshDir, 'id_rsa')
    // A key without a trailing newline is rejected by OpenSSH.
    const key = inputs.sshKey.endsWith('\n') ? inputs.sshKey : `${inputs.sshKey}\n`

    if (existsSync(keyPath)) {
      appendFileSync(keyPath, key)
    } else {
      writeFileSync(keyPath, key, { mode: 0o600 })
    }
    chmodSync(keyPath, 0o600)

    written.sshKeyWritten = true
  }

  return written
}

/** Reads a file's contents, for tests and diagnostics. */
export function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}