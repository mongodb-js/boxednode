'use strict';
import { Logger, LoggerImpl } from './logger';
import fetch from 'node-fetch';
import semver from 'semver';
import tar from 'tar';
import path from 'path';
import zlib from 'zlib';
import stream from 'stream';
import childProcess from 'child_process';
import os from 'os';
import rimraf from 'rimraf';
import { once } from 'events';
import { promisify } from 'util';
import { promises as fs } from 'fs';

const pipeline = promisify(stream.pipeline);

type NodeVersionInfo = {
  version: string,
  files: string[],
  // ... and others.
}

// Get a list of all published Node.js versions.
async function getNodeVersionInfo (): Promise<NodeVersionInfo[]> {
  const resp = await fetch('https://nodejs.org/download/release/index.json');
  if (!resp.ok) {
    throw new Error(`Could not get Node.js version info from nodejs.org/download: ${resp.statusText}`);
  }
  return await resp.json();
}

// Pick the highest Node.js version matching a specific semver range.
async function getBestNodeVersionForRange (range: string): Promise<NodeVersionInfo> {
  const versionInfos = await getNodeVersionInfo();

  let maxVersion: NodeVersionInfo|null = null;
  for (const info of versionInfos) {
    if (!semver.satisfies(info.version, range)) {
      continue; // Skip, not interested in this version anyway
    }

    if (maxVersion === null || semver.gt(info.version, maxVersion.version)) {
      maxVersion = info;
    }
  }

  if (!maxVersion) {
    throw new Error(`Could not find matching Node.js version for ${JSON.stringify(range)}`);
  }

  return maxVersion;
}

// Download and unpack a tarball containing the code for a specific Node.js version.
async function getNodeSourceForVersion (range: string, dir: string, logger: Logger): Promise<[string, string]> {
  logger.stepStarting(`Looking for Node.js version matching ${JSON.stringify(range)}`);
  const { version } = await getBestNodeVersionForRange(range);

  const url = `https://nodejs.org/download/release/${version}/node-${version}.tar.gz`;
  logger.stepStarting(`Downloading from ${url}`);

  const tarball = await fetch(url);

  if (!tarball.ok) {
    throw new Error(`Could not download Node.js source tarball: ${tarball.statusText}`);
  }

  logger.stepStarting(`Unpacking tarball to ${dir}`);
  await fs.mkdir(dir, { recursive: true });

  // Streaming unpack. This will create the directory `${dir}/node-${version}`
  // with the Node.js source tarball contents in it.
  await pipeline(
    tarball.body,
    zlib.createGunzip(),
    tar.x({
      cwd: dir
    })
  );

  logger.stepCompleted();

  return [version, path.join(dir, `node-${version}`)];
}

type BuildCommandOptions = {
  cwd: string,
  logger: Logger,
};

// Run a build command, e.g. `./configure`, `make`, `vcbuild`, etc.
async function spawnBuildCommand (command: string[],
  options: BuildCommandOptions): Promise<void> {
  options.logger.stepStarting(`Running ${command.join(' ')}`);
  // We're not using childProcess.exec* because we do want to pass the output
  // through here and not handle it ourselves.
  const proc = childProcess.spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    ...options
  });
  const [code] = await once(proc, 'exit');
  if (code !== 0) {
    throw new Error(`Command failed: ${command.join(' ')} (code ${code})`);
  }
  options.logger.stepCompleted();
}

// Compile a Node.js build in a given directory from source
async function compileNode (sourcePath: string, linkedJSModules: string[], logger: Logger): Promise<string> {
  logger.stepStarting('Compiling Node.js from source');
  const cpus = os.cpus().length;
  const options = {
    cwd: sourcePath,
    logger: logger
  };

  if (process.platform !== 'win32') {
    const configureArgs: string[] = [];
    for (const module of linkedJSModules) {
      configureArgs.push('--link-module', module);
    }
    await spawnBuildCommand(['./configure', ...configureArgs], options);
    await spawnBuildCommand(['make', `-j${cpus}`, 'V='], options);

    return path.join(sourcePath, 'out', 'Release', 'node');
  } else {
    // These settings got things to work locally. We may want to make this configurable.
    const vcbuildArgs: string[] = ['release', 'vs2019'];
    for (const module of linkedJSModules) {
      vcbuildArgs.push('link-module', module);
    }
    await spawnBuildCommand(['.\\vcbuild.bat', ...vcbuildArgs], options);

    return path.join(sourcePath, 'Release', 'node.exe');
  }
}

type CompilationOptions = {
  nodeVersionRange: string,
  tmpdir?: string,
  sourceFile: string,
  targetFile: string,
  logger?: Logger,
  clean?: boolean
}

async function compileJSFileAsBinaryImpl (options: CompilationOptions, logger: Logger): Promise<void> {
  if (!options.sourceFile.endsWith('.js')) {
    throw new Error(`Only .js files can be compiled (got: ${options.sourceFile})`);
  }
  await fs.access(options.sourceFile);

  // We'll put the source file in a namespaced path in the target directory.
  // For example, if the file name is `myproject.js`, then it will be available
  // for importing as `require('myproject/myproject')`.
  const namespace = path.basename(options.sourceFile, '.js');
  if (!options.tmpdir) {
    // We're not adding random data here, so that the paths can be part of a
    // compile caching mechanism like sccache.
    options.tmpdir = path.join(os.tmpdir(), 'boxednode', namespace);
  }

  const [nodeVersion, nodeSourcePath] = await getNodeSourceForVersion(
    options.nodeVersionRange, options.tmpdir, logger);

  logger.stepStarting('Inserting custom code into Node.js source');
  await fs.mkdir(path.join(nodeSourcePath, 'lib', namespace), { recursive: true });
  await fs.copyFile(options.sourceFile,
    path.join(nodeSourcePath, 'lib', namespace, path.basename(options.sourceFile)));
  const extraJSSourceFiles = [`./lib/${namespace}/${namespace}.js`];

  // In Node.js 14.x and above, we use the official embedder API for stability.
  // In Node.js 12.x and below, we use the legacy _third_party_main mechanism
  // that will be removed in future Node.js versions.
  // (The official embedder API will *probably* end up in a later v12.x release
  // as well -- not clear yet at the time of writing, see
  // https://github.com/nodejs/node/pull/35241.)
  if (semver.gte(nodeVersion, '14.0.0')) {
    let mainSource = await fs.readFile(
      path.join(__dirname, '..', 'resources', 'main-template.cc'), 'utf8');
    mainSource = mainSource.replace(/\bREPLACE_WITH_ENTRY_POINT\b/g,
      JSON.stringify(JSON.stringify(`${namespace}/${namespace}`)));
    await fs.writeFile(path.join(nodeSourcePath, 'src', 'node_main.cc'), mainSource);
  } else {
    let tpmSource = await fs.readFile(
      path.join(__dirname, '..', 'resources', 'third_party_main.js'), 'utf8');
    tpmSource = tpmSource.replace(/\bREPLACE_WITH_ENTRY_POINT\b/g,
      JSON.stringify(`${namespace}/${namespace}`));
    await fs.writeFile(path.join(nodeSourcePath, 'lib', '_third_party_main.js'), tpmSource);
    extraJSSourceFiles.push('./lib/_third_party_main.js');

    // This is the 'only' hack in here: We suppress Node.js options parsing so
    // all options end up in process.argv. For that, we remove the main call
    // to node::ProcessGlobalArgs().
    let nodeCCSource = await fs.readFile(
      path.join(nodeSourcePath, 'src', 'node.cc'), 'utf8');
    nodeCCSource = nodeCCSource.replace(
      /ProcessGlobalArgs\((?:[^{};]|[\r\n])*?kDisallowedInEnvironment(?:[^{}]|[\r\n])*?\)/,
      '0');
    await fs.writeFile(path.join(nodeSourcePath, 'src', 'node.cc'), nodeCCSource);
  }

  const binaryPath = await compileNode(nodeSourcePath, extraJSSourceFiles, logger);

  logger.stepStarting(`Moving resulting binary to ${options.targetFile}`);
  await fs.mkdir(path.dirname(options.targetFile), { recursive: true });
  await fs.copyFile(binaryPath, options.targetFile);
  logger.stepCompleted();

  if (options.clean) {
    logger.stepStarting('Cleaning temporary directory');
    await promisify(rimraf)(options.tmpdir, { glob: false });
    logger.stepCompleted();
  }
}

export async function compileJSFileAsBinary (options: CompilationOptions): Promise<void> {
  const logger = options.logger || new LoggerImpl();
  try {
    await compileJSFileAsBinaryImpl(options, logger);
  } catch (err) {
    logger.stepFailed(err);
    throw err;
  }
}
