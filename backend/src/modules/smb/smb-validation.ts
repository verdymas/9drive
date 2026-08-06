import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '../../utils/app-error.js'
import { isValidShareName, normalizeShareName } from './smb-config.js'

export type PathChecker = {
  exists: (file: string) => boolean
  isDirectory: (file: string) => boolean
}

/** Allow tests to resolve paths against a fixed root regardless of host OS. */
export type PathResolver = (rawPath: string, root: string) => string

const defaultPathChecker: PathChecker = {
  exists: (file) => fs.existsSync(file),
  isDirectory: (file) => fs.statSync(file).isDirectory(),
}

let pathChecker: PathChecker = defaultPathChecker
let pathResolver: PathResolver = (rawPath, root) => {
  if (rawPath.includes('\0')) {
    throw new AppError('PATH_INVALID', 'Path contains invalid characters.')
  }
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, rawPath)
  const relative = path.relative(resolvedRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new AppError('PATH_TRAVERSAL', 'Path must stay inside the allowed storage root.')
  }
  return resolved
}

/**
 * Override the filesystem probe used for path validation. The Samba manager
 * runs on Linux; tests (which may run on Windows) inject a fake checker so the
 * "directory exists" rule is testable without a real Samba host.
 */
export function setPathChecker(checker: PathChecker): void {
  pathChecker = checker
}

export function setPathResolver(resolver: PathResolver): void {
  pathResolver = resolver
}

export function resetPathChecker(): void {
  pathChecker = defaultPathChecker
  pathResolver = (rawPath, root) => {
    if (rawPath.includes('\0')) {
      throw new AppError('PATH_INVALID', 'Path contains invalid characters.')
    }
    const resolvedRoot = path.resolve(root)
    const resolved = path.resolve(resolvedRoot, rawPath)
    const relative = path.relative(resolvedRoot, resolved)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AppError('PATH_TRAVERSAL', 'Path must stay inside the allowed storage root.')
    }
    return resolved
  }
}

/** Regex matched against share names; Samba itself only allows `[^\[\]]+`. */
const USER_NAME_PATTERN = /^[a-z_][a-z0-9._-]{0,31}$/

export function assertValidShareName(raw: string): string {
  const name = normalizeShareName(raw)
  if (!isValidShareName(name)) {
    throw new AppError('SHARE_NAME_INVALID', 'Share name may only contain letters, digits, spaces, underscores and dashes (max 80 characters).')
  }
  return name
}

export function assertValidUserName(name: string): string {
  const trimmed = name.trim()
  if (!USER_NAME_PATTERN.test(trimmed)) {
    throw new AppError('USER_NAME_INVALID', 'SMB user names must start with a lowercase letter or underscore and contain only lowercase letters, digits, dots, dashes and underscores (max 32 characters).')
  }
  return trimmed
}

export function assertValidPassword(password: string): void {
  if (typeof password !== 'string' || password.length < 8 || password.length > 64) {
    throw new AppError('PASSWORD_POLICY', 'Password must be between 8 and 64 characters.')
  }
}

/** Reject `..`, absolute paths and NUL bytes; resolve against `root` for symlink safety. */
export function assertPathInsideRoot(rawPath: string, root: string): string {
  return pathResolver(rawPath, root)
}

export function assertExistingDirectory(rawPath: string, root: string): string {
  const resolved = assertPathInsideRoot(rawPath, root)
  if (!pathChecker.exists(resolved)) {
    throw new AppError('PATH_MISSING', `Path does not exist: ${resolved}`)
  }
  if (!pathChecker.isDirectory(resolved)) {
    throw new AppError('PATH_NOT_DIRECTORY', `Path is not a directory: ${resolved}`)
  }
  return resolved
}

/** Samba's `valid users` values must reference existing system users. */
export function assertSystemUserExists(user: string): void {
  try {
    process.getuid?.()
  } catch {
    return
  }
  if (process.platform === 'win32') return
  try {
    const users = fs.readFileSync('/etc/passwd', 'utf8')
    const found = users.split('\n').some((line) => line.split(':')[0] === user)
    if (!found) {
      throw new AppError('USER_NOT_FOUND', `SMB user '${user}' does not exist as a system user.`)
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    // /etc/passwd unreadable — let Samba decide at runtime.
  }
}

/** Samba's `valid groups` values must reference existing system groups. */
export function assertSystemGroupExists(group: string): void {
  if (process.platform === 'win32') return
  try {
    const groups = fs.readFileSync('/etc/group', 'utf8')
    const found = groups.split('\n').some((line) => line.split(':')[0] === group)
    if (!found) {
      throw new AppError('GROUP_NOT_FOUND', `System group '${group}' does not exist.`)
    }
  } catch {
    // /etc/group unreadable — let Samba decide at runtime.
  }
}
