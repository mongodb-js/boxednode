/* eslint-disable dot-notation */
import { promises as fs } from 'fs';
import { parse } from 'gyp-parser';
import path from 'path';
import pkgUp from 'pkg-up';
import { Logger } from './logger';
import { copyRecursive, ProcessEnv, objhash, spawnBuildCommand, npm } from './helpers';

export type AddonConfig = {
  path: string,
  requireRegexp: RegExp
}

export type AddonResult = {
  targetName: string,
  registerFunction: string,
  linkedModuleName: string
}

type GypConfig = {
  targets?: GypConfig[],
  ['defines']?: string[],
  ['defines!']?: string[],
  type?: string,
  dependencies?: string[],
  ['target_name']?: string,
  includes?: string[],
  variables?: Record<string, string>
};

export async function loadGYPConfig (filename: string): Promise<GypConfig> {
  try {
    return parse(await fs.readFile(filename, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${filename}: ${err.message}`);
  }
}

export async function storeGYPConfig (filename: string, config: GypConfig): Promise<void> {
  return await fs.writeFile(filename, JSON.stringify(config, null, '  '));
}

function turnIntoStaticLibrary (config: GypConfig, addonId: string): AddonResult[] {
  if (!Array.isArray(config.targets)) return [];
  const result: AddonResult[] = [];

  for (const target of config.targets) {
    if (!target.type || target.type === 'loadable_module') {
      target.type = 'static_library';
    }
    const registerFunction = `boxednode_${target.target_name}_register_${addonId}`;
    const linkedModuleName = `boxednode_${target.target_name}_${addonId}`;
    const posDefines = new Set(target['defines'] || []);
    const negDefines = new Set(target['defines!'] || []);
    for (const dontWant of [
      'USING_UV_SHARED=1', 'USING_V8_SHARED=1', 'BUILDING_NODE_EXTENSION'
    ]) {
      negDefines.add(dontWant);
      posDefines.delete(dontWant);
    }
    for (const want of [
      'BUILDING_BOXEDNODE_EXTENSION',
      `BOXEDNODE_REGISTER_FUNCTION=${registerFunction}`,
      `BOXEDNODE_MODULE_NAME=${linkedModuleName}`
    ]) {
      negDefines.delete(want);
      posDefines.add(want);
    }
    target['defines'] = [...posDefines];
    target['defines!'] = [...negDefines];
    target['win_delay_load_hook'] = 'false';

    result.push({
      targetName: target.target_name,
      registerFunction,
      linkedModuleName
    });
  }
  return result;
}

async function prepForUsageWithNode (
  config: GypConfig,
  nodeSourcePath: string): Promise<void> {
  const nodeGypDir = path.dirname(await pkgUp({ cwd: require.resolve('node-gyp') }));
  (config.includes = config.includes || []).push(
    path.join(nodeGypDir, 'addon.gypi')
  );
  // Remove node-addon-api gyp dummy, which inserts nothing.c into
  // the build tree, which can conflict with other target's nothing.c
  // files.
  config.dependencies = config.dependencies?.filter(
    dep => !/require\s*\(.+node-addon-api.+\)\s*\.\s*gyp/.test(dep)) ?? [];
  config.variables = {
    ...(config.variables || {}),
    'node_root_dir%': nodeSourcePath,
    'standalone_static_library%': '1',
    'node_engine%': 'v8',
    'node_gyp_dir%': nodeGypDir,
    'library%': 'static_library',
    'visibility%': 'default',
    'module_root_dir%': nodeSourcePath,
    // Not what node-gyp is going for, but that's okay.
    'node_lib_file%': 'kernel32.lib',
    'win_delay_load_hook%': 'false'
  };
}

export async function modifyAddonGyp (
  addon: AddonConfig,
  nodeSourcePath: string,
  env: ProcessEnv,
  logger: Logger): Promise<AddonResult[]> {
  logger.stepStarting(`Copying addon at ${addon.path}`);
  const addonId = objhash(addon);
  const addonPath = path.resolve(nodeSourcePath, 'deps', addonId);
  await copyRecursive(addon.path, addonPath);
  logger.stepCompleted();

  await spawnBuildCommand([...npm(), 'install', '--ignore-scripts', '--production'], {
    cwd: addonPath,
    logger,
    env
  });

  logger.stepStarting(`Preparing addon at ${addon.path}`);
  const sourceGYP = path.resolve(addonPath, 'binding.gyp');
  const targetGYP = path.resolve(addonPath, '.boxednode.gyp');

  const config = await loadGYPConfig(sourceGYP);
  const addonResult = turnIntoStaticLibrary(config, addonId);
  await prepForUsageWithNode(config, nodeSourcePath);
  await storeGYPConfig(targetGYP, config);
  logger.stepCompleted();

  const targetGYPRelative = path.relative(nodeSourcePath, targetGYP);
  return addonResult.map(({ targetName, registerFunction, linkedModuleName }) => ({
    targetName: `${targetGYPRelative}:${targetName}`,
    registerFunction,
    linkedModuleName
  }));
}
