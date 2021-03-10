import { promises as fs } from 'fs';
import { Logger } from './logger';
import crypto from 'crypto';
import childProcess from 'child_process';
import { promisify } from 'util';
import tar from 'tar';
import stream from 'stream';
import { once } from 'events';

export const pipeline = promisify(stream.pipeline);

export type ProcessEnv = { [name: string]: string | undefined };

export type BuildCommandOptions = {
  cwd: string,
  logger: Logger,
  env: ProcessEnv,
};

// Run a build command, e.g. `./configure`, `make`, `vcbuild`, etc.
export async function spawnBuildCommand (
  command: string[],
  options: BuildCommandOptions): Promise<void> {
  options.logger.stepStarting(`Running ${command.join(' ')}`);
  // Fun stuff: Sometime between Node.js 14.15.0 and 14.16.0,
  // the case handling of PATH on win32 changed, and the build
  // will fail if the env var's case is e.g. Path instead of PATH.
  // We normalize to PATH here.
  const env = options.env;
  if (process.platform === 'win32') {
    const PATH = env.PATH ?? env.Path ?? env.path;
    delete env.PATH;
    delete env.Path;
    delete env.path;
    env.PATH = PATH;
  }
  // We're not using childProcess.exec* because we do want to pass the output
  // through here and not handle it ourselves.
  const proc = childProcess.spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    ...options,
    env
  });
  const [code] = await once(proc, 'exit');
  if (code !== 0) {
    throw new Error(`Command failed: ${command.join(' ')} (code ${code})`);
  }
  options.logger.stepCompleted();
}

export async function copyRecursive (sourceDir: string, targetDir: string): Promise<void> {
  await fs.mkdir(targetDir, { recursive: true });
  await pipeline(
    tar.c({
      cwd: sourceDir,
      gzip: false
    }, ['./']),
    tar.x({
      cwd: targetDir
    })
  );
}

export function objhash (value: unknown): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 32);
}

export function npm (): string[] {
  if (process.env.npm_execpath) {
    return [process.execPath, process.env.npm_execpath];
  } else {
    return ['npm'];
  }
}
