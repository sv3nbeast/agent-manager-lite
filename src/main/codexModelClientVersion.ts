import { execFile } from 'node:child_process'
import { lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { InstanceApplication } from '../shared/instances'
import { codexDesktopEnvironment, getInstanceClientAdapter } from './codexInstanceAdapter'
import { resolveCliRuntime } from './cliResolver'

const missingCLI = () => new Error('所选客户端缺少可安全读取版本的 Codex CLI，请重新选择客户端程序')

function bundledCLI(application: InstanceApplication): string {
  const resources = join(application.path, 'Contents', 'Resources')
  const candidates = [
    // Current bundles ship a signed CLI app behind a shell launcher. Invoke
    // the native program directly, rather than executing the launcher script.
    join(resources, 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'),
    join(resources, 'codex-cli', 'bin', 'codex'),
    join(resources, 'codex')
  ]
  for (const candidate of candidates) {
    try { lstatSync(candidate) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw missingCLI()
    }
    try {
      const canonical = realpathSync(candidate), path = relative(resources, canonical), stat = lstatSync(canonical)
      // Bundle-local links are legitimate, but cannot redirect discovery to a
      // different installation, another program outside Resources, or a script.
      if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path) || !stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111)
        || resolveCliRuntime(canonical).executable !== canonical) throw new Error('invalid')
      return canonical
    } catch { throw missingCLI() }
  }
  throw missingCLI()
}

/** The models endpoint uses the bundled CLI version, rather than the desktop UI version. */
export async function readCodexModelClientVersion(application: InstanceApplication, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const adapter = getInstanceClientAdapter(application.clientType)
  adapter.validateApplication({ clientType: adapter.client.id, extraArgs: [] }, application)
  const runtime = adapter.launchRuntime(application)
  // Validating the desktop runtime checks registration and the .app layout;
  // its Electron executable must never be invoked to discover the CLI version.
  const executable = application.kind === 'cli' ? runtime.executable : bundledCLI(application)
  try {
    const stat = lstatSync(executable)
    if (realpathSync(executable) !== executable || stat.isSymbolicLink() || !stat.isFile() || !(stat.mode & 0o111)) throw new Error('invalid')
  } catch { throw missingCLI() }

  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'cml-model-client-version-')))
  try {
    signal.throwIfAborted()
    const env = { ...codexDesktopEnvironment(process.env), CODEX_HOME: directory }
    const output = await new Promise<string>((resolve, reject) => {
      let failed = false, stdout: string | undefined
      const child = execFile(executable, ['--version'], { cwd: directory, env, timeout: 4000, maxBuffer: 64 * 1024, signal, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8' }, (error, output) => {
        failed = !!error; stdout = output
      })
      // An AbortError callback can precede process exit. Reap the child before
      // deleting its working directory or resolving cancellation to the caller.
      child.once('close', () => {
        if (failed || stdout === undefined) reject(new Error('读取 Codex CLI 版本失败或超时，请检查所选客户端程序'))
        else resolve(stdout)
      })
    })
    signal.throwIfAborted()
    const version = output.trim().match(/^codex-cli\s+((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)$/)?.[1]
    if (!version) throw new Error('Codex CLI 未返回有效的客户端版本，请重新选择客户端程序')
    return version
  } catch (error) {
    signal.throwIfAborted()
    throw error
  } finally { rmSync(directory, { recursive: true, force: true }) }
}
