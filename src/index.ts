'use strict';
import { Logger, LoggerImpl } from './logger';
import fetch from 'node-fetch';
import tar from 'tar';
import path from 'path';
import zlib from 'zlib';
import os from 'os';
import rimraf from 'rimraf';
import crypto from 'crypto';
import { promisify } from 'util';
import { promises as fs, createReadStream, createWriteStream } from 'fs';
import { AddonConfig, loadGYPConfig, storeGYPConfig, modifyAddonGyp } from './native-addons';
import { ExecutableMetadata, generateRCFile } from './executable-metadata';
import { spawnBuildCommand, ProcessEnv, pipeline, createCppJsStringDefinition } from './helpers';
import { Readable } from 'stream';
import nv from '@pkgjs/nv';
import { fileURLToPath, URL } from 'url';

// Download and unpack a tarball containing the code for a specific Node.js version.
async function getNodeSourceForVersion (range: string, dir: string, logger: Logger, retries = 2): Promise<string> {
  logger.stepStarting(`Looking for Node.js version matching ${JSON.stringify(range)}`);

  let inputIsFileUrl = false;
  try {
    inputIsFileUrl = new URL(range).protocol === 'file:';
  } catch { /* not a valid URL */ }

  if (inputIsFileUrl) {
    logger.stepStarting(`Extracting tarball from ${range}`);
    await pipeline(
      createReadStream(fileURLToPath(range)),
      zlib.createGunzip(),
      tar.x({
        cwd: dir
      })
    );
    logger.stepCompleted();
    const filesInDir = await fs.readdir(dir, { withFileTypes: true });
    const dirsInDir = filesInDir.filter(f => f.isDirectory());
    if (dirsInDir.length !== 1) {
      throw new Error('Node.js tarballs should contain exactly one directory');
    }
    return path.join(dir, dirsInDir[0].name);
  }

  const ver = (await nv(range)).pop();
  if (!ver) {
    throw new Error(`No node version found for ${range}`);
  }
  const version = `v${ver.version}`;

  const releaseBaseUrl = `https://nodejs.org/download/release/${version}`;
  const tarballName = `node-${version}.tar.gz`;
  const cachedTarballPath = path.join(dir, tarballName);

  let hasCachedTarball = false;
  try {
    hasCachedTarball = (await fs.stat(cachedTarballPath)).size > 0;
  } catch {}
  if (hasCachedTarball) {
    const shaSumsUrl = `${releaseBaseUrl}/SHASUMS256.txt`;
    logger.stepStarting(`Verifying existing tarball via ${shaSumsUrl}`);
    const [expectedSha, realSha] = await Promise.all([
      (async () => {
        try {
          const shaSums = await fetch(shaSumsUrl);
          if (!shaSums.ok) return;
          const text = await shaSums.text();
          for (const line of text.split('\n')) {
            if (line.trim().endsWith(tarballName)) {
              return line.match(/^([0-9a-fA-F]+)\b/)[0];
            }
          }
        } catch {}
      })(),
      (async () => {
        const hash = crypto.createHash('sha256');
        await pipeline(createReadStream(cachedTarballPath), hash);
        return hash.digest('hex');
      })()
    ]);
    if (expectedSha === realSha) {
      logger.stepStarting('Unpacking existing tarball');
    } else {
      logger.stepFailed(new Error(
        `SHA256 mismatch: got ${realSha}, expected ${expectedSha}`));
      hasCachedTarball = false;
    }
  }

  let tarballStream: Readable;
  let tarballWritePromise: Promise<unknown>;
  if (hasCachedTarball) {
    tarballStream = createReadStream(cachedTarballPath);
  } else {
    const url = `${releaseBaseUrl}/${tarballName}`;
    logger.stepStarting(`Downloading from ${url}`);

    const tarball = await fetch(url);

    if (!tarball.ok) {
      throw new Error(`Could not download Node.js source tarball: ${tarball.statusText}`);
    }

    logger.stepStarting(`Unpacking tarball to ${dir}`);
    await fs.mkdir(dir, { recursive: true });

    const contentLength = +tarball.headers.get('Content-Length');
    if (contentLength) {
      logger.startProgress(contentLength);
      let downloaded = 0;
      tarball.body.on('data', (chunk) => {
        downloaded += chunk.length;
        logger.doProgress(downloaded);
      });
    }

    tarballStream = tarball.body;
    // It is important that this happens in the same tick as the streaming
    // unpack below in order not to lose any data.
    tarballWritePromise =
      pipeline(tarball.body, createWriteStream(cachedTarballPath));
  }

  // Streaming unpack. This will create the directory `${dir}/node-${version}`
  // with the Node.js source tarball contents in it.
  try {
    await pipeline(
      tarballStream,
      zlib.createGunzip(),
      tar.x({
        cwd: dir
      })
    );
    await tarballWritePromise;
  } catch (err) {
    if (retries > 0) {
      logger.stepFailed(err);
      logger.stepStarting('Re-trying');
      return await getNodeSourceForVersion(range, dir, logger, retries - 1);
    }
    throw err;
  }

  logger.stepCompleted();

  return path.join(dir, `node-${version}`);
}

async function getNodeVersionFromSourceDirectory (dir: string): Promise<[number, number, number]> {
  const versionFile = await fs.readFile(path.join(dir, 'src', 'node_version.h'), 'utf8');

  const major = +versionFile.match(/^#define\s+NODE_MAJOR_VERSION\s+(?<version>\d+)\s*$/m)?.groups?.version;
  const minor = +versionFile.match(/^#define\s+NODE_MINOR_VERSION\s+(?<version>\d+)\s*$/m)?.groups?.version;
  const patch = +versionFile.match(/^#define\s+NODE_PATCH_VERSION\s+(?<version>\d+)\s*$/m)?.groups?.version;
  return [major, minor, patch];
}

// Compile a Node.js build in a given directory from source
async function compileNode (
  sourcePath: string,
  linkedJSModules: string[],
  buildArgs: string[],
  makeArgs: string[],
  env: ProcessEnv,
  logger: Logger): Promise<string> {
  logger.stepStarting('Compiling Node.js from source');
  const cpus = os.cpus().length;
  const options = {
    cwd: sourcePath,
    logger: logger,
    env: env
  };

  // Node.js 19.4.0 is currently the minimum version that has https://github.com/nodejs/node/pull/45887.
  // We want to disable the shared-ro-heap flag since it would require
  // all snapshots used by Node.js to be equal, something that we don't
  // want to or need to guarantee as embedders.
  const nodeVersion = await getNodeVersionFromSourceDirectory(sourcePath);
  if (nodeVersion[0] > 19 || (nodeVersion[0] === 19 && nodeVersion[1] >= 4)) {
    if (process.platform !== 'win32') {
      buildArgs.unshift('--disable-shared-readonly-heap');
    } else {
      buildArgs.unshift('no-shared-roheap');
    }
  }

  if (process.platform !== 'win32') {
    const configure: string[] = ['./configure', ...buildArgs];
    for (const module of linkedJSModules) {
      configure.push('--link-module', module);
    }
    await spawnBuildCommand(configure, options);

    const make = ['make', ...makeArgs];
    if (!make.some((arg) => /^-j/.test(arg))) { make.push(`-j${cpus}`); }

    if (!make.some((arg) => /^V=/.test(arg))) { make.push('V='); }

    await spawnBuildCommand(make, options);

    return path.join(sourcePath, 'out', 'Release', 'node');
  } else {
    // These defaults got things to work locally. We only include them if no
    // conflicting arguments have been passed manually.
    const vcbuildArgs: string[] = [...buildArgs, ...makeArgs, 'projgen'];
    if (!vcbuildArgs.includes('debug') && !vcbuildArgs.includes('release')) { vcbuildArgs.push('release'); }
    if (!vcbuildArgs.some((arg) => /^vs/.test(arg))) { vcbuildArgs.push('vs2019'); }

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
  configureArgs?: string[],
  makeArgs?: string[],
  logger?: Logger,
  clean?: boolean,
  env?: ProcessEnv,
  namespace?: string,
  addons?: AddonConfig[],
  enableBindingsPatch?: boolean,
  executableMetadata?: ExecutableMetadata,
  preCompileHook?: (nodeSourceTree: string, options: CompilationOptions) => void | Promise<void>
}

async function compileJSFileAsBinaryImpl (options: CompilationOptions, logger: Logger): Promise<void> {
  if (!options.sourceFile.endsWith('.js')) {
    throw new Error(`Only .js files can be compiled (got: ${options.sourceFile})`);
  }
  await fs.access(options.sourceFile);

  // We'll put the source file in a namespaced path in the target directory.
  // For example, if the file name is `myproject.js`, then it will be available
  // for importing as `require('myproject/myproject')`.
  const namespace = options.namespace || path.basename(options.sourceFile, '.js');
  if (!options.tmpdir) {
    // We're not adding random data here, so that the paths can be part of a
    // compile caching mechanism like sccache.
    options.tmpdir = path.join(os.tmpdir(), 'boxednode', namespace);
  }

  const nodeSourcePath = await getNodeSourceForVersion(
    options.nodeVersionRange, options.tmpdir, logger);

  const requireMappings: [RegExp, string][] = [];
  const extraJSSourceFiles: string[] = [];
  const enableBindingsPatch = options.enableBindingsPatch ?? options.addons?.length > 0;

  const jsMainSource = await fs.readFile(options.sourceFile, 'utf8');

  // We use the official embedder API for stability, which is available in all
  // supported versions of Node.js.
  {
    const extraGypDependencies: string[] = [];
    const registerFunctions: string[] = [];
    for (const addon of (options.addons || [])) {
      const addonResult = await modifyAddonGyp(
        addon, nodeSourcePath, options.env || process.env, logger);
      for (const { linkedModuleName, targetName, registerFunction } of addonResult) {
        requireMappings.push([addon.requireRegexp, linkedModuleName]);
        extraGypDependencies.push(targetName);
        registerFunctions.push(registerFunction);
      }
    }

    logger.stepStarting('Finalizing linked addons processing');
    const nodeGypPath = path.join(nodeSourcePath, 'node.gyp');
    const nodeGyp = await loadGYPConfig(nodeGypPath);
    const mainTarget = nodeGyp.targets.find(
      (target) => ['<(node_core_target_name)', 'node'].includes(target.target_name));
    mainTarget.dependencies = [...(mainTarget.dependencies || []), ...extraGypDependencies];
    await storeGYPConfig(nodeGypPath, nodeGyp);

    for (const header of ['node.h', 'node_api.h']) {
      const source = (
        await fs.readFile(path.join(nodeSourcePath, 'src', header), 'utf8') +
        await fs.readFile(path.join(__dirname, '..', 'resources', `add-${header}`), 'utf8')
      );
      await fs.writeFile(path.join(nodeSourcePath, 'src', header), source);
    }
    logger.stepCompleted();

    logger.stepStarting('Handling main file source');
    let mainSource = await fs.readFile(
      path.join(__dirname, '..', 'resources', 'main-template.cc'), 'utf8');
    mainSource = mainSource.replace(/\bREPLACE_WITH_ENTRY_POINT\b/g,
      JSON.stringify(JSON.stringify(`${namespace}/${namespace}`)));
    mainSource = mainSource.replace(/\bREPLACE_DECLARE_LINKED_MODULES\b/g,
      registerFunctions.map((fn) => `void ${fn}(const void**,const void**);\n`).join(''));
    mainSource = mainSource.replace(/\bREPLACE_DEFINE_LINKED_MODULES\b/g,
      registerFunctions.map((fn) => `${fn},`).join(''));
    mainSource = mainSource.replace(/\bREPLACE_WITH_MAIN_SCRIPT_SOURCE_GETTER\b/g,
      createCppJsStringDefinition('GetBoxednodeMainScriptSource', jsMainSource));
    await fs.writeFile(path.join(nodeSourcePath, 'src', 'node_main.cc'), mainSource);
    logger.stepCompleted();
  }

  logger.stepStarting('Inserting custom code into Node.js source');
  await fs.mkdir(path.join(nodeSourcePath, 'lib', namespace), { recursive: true });
  let entryPointTrampolineSource = await fs.readFile(
    path.join(__dirname, '..', 'resources', 'entry-point-trampoline.js'), 'utf8');
  entryPointTrampolineSource = entryPointTrampolineSource.replace(
    /\bREPLACE_WITH_BOXEDNODE_CONFIG\b/g,
    JSON.stringify({
      requireMappings: requireMappings.map(([re, linked]) => [re.source, re.flags, linked]),
      enableBindingsPatch
    }));
  await fs.writeFile(
    path.join(nodeSourcePath, 'lib', namespace, `${namespace}.js`),
    entryPointTrampolineSource);
  extraJSSourceFiles.push(`./lib/${namespace}/${namespace}.js`);
  logger.stepCompleted();

  logger.stepStarting('Storing executable metadata');
  const resPath = path.join(nodeSourcePath, 'src', 'res');
  await fs.writeFile(
    path.join(resPath, 'node.rc'),
    await generateRCFile(resPath, options.targetFile, options.executableMetadata));
  logger.stepCompleted();

  if (options.preCompileHook) {
    logger.stepStarting('Running pre-compile hook');
    await options.preCompileHook(nodeSourcePath, options);
    logger.stepCompleted();
  }

  const binaryPath = await compileNode(
    nodeSourcePath,
    extraJSSourceFiles,
    options.configureArgs,
    options.makeArgs,
    options.env || process.env,
    logger);

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

// Allow specifying arguments to make/configure/vcbuild through env vars,
// either as a comma-separated list or as a JSON array
function parseEnvVarArgList (value: string | undefined): string[] {
  if (!value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return value.split(',');
  }
}

export async function compileJSFileAsBinary (options: Readonly<CompilationOptions>): Promise<void> {
  const logger = options.logger || new LoggerImpl();

  const configureArgs = [...(options.configureArgs || [])];
  configureArgs.push(...parseEnvVarArgList(process.env.BOXEDNODE_CONFIGURE_ARGS));

  const makeArgs = [...(options.makeArgs || [])];
  makeArgs.push(...parseEnvVarArgList(process.env.BOXEDNODE_MAKE_ARGS));

  try {
    await compileJSFileAsBinaryImpl({
      ...options,
      configureArgs,
      makeArgs
    }, logger);
  } catch (err) {
    logger.stepFailed(err);
    throw err;
  }
}
