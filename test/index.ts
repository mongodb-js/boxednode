import { compileJSFileAsBinary } from '..';
import path from 'path';
import assert from 'assert';
import childProcess from 'child_process';
import semver from 'semver';
import { promisify } from 'util';
import pkgUp from 'pkg-up';
import { promises as fs } from 'fs';

const execFile = promisify(childProcess.execFile);
const exeSuffix = process.platform === 'win32' ? '.exe' : '';

// We shard the tests on Windows because compiling isn't cached there.

describe('basic functionality', () => {
  // Test the currently running Node.js version. Other versions can be checked
  // manually that way, or through the CI matrix.
  const version = process.version.slice(1).replace(/-.*$/, '');

  describe(`On Node v${version}`, function () {
    it('works in a simple case (shard 1)', async function () {
      this.timeout(2 * 60 * 60 * 1000); // 2 hours
      await compileJSFileAsBinary({
        nodeVersionRange: version,
        sourceFile: path.resolve(__dirname, 'resources/example.js'),
        targetFile: path.resolve(__dirname, `resources/example${exeSuffix}`)
      });

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), [],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, 'Hello world!\n');
      }

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), ['42'],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, '42\n');
      }

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), ['process.argv.length'],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, '3\n');
      }

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), ['process.argv[1] === process.execPath'],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, 'true\n');
      }

      if (process.platform !== 'win32') {
        const proc = childProcess.spawn(
          path.resolve(__dirname, `resources/example${exeSuffix}`),
          ['process.title = "bananananana"; setInterval(() => {}, 1000);']);

        const { stdout } = await execFile('ps', ['aux'], { encoding: 'utf8' });
        assert(stdout.includes('bananananana'), `Missed process.title change in ${stdout}`);
        proc.kill();
      }
    });

    it('works with a Nan addon (shard 2)', async function () {
      if (semver.lt(version, '12.19.0')) {
        return this.skip(); // no addon support available
      }

      this.timeout(2 * 60 * 60 * 1000); // 2 hours
      await compileJSFileAsBinary({
        nodeVersionRange: version,
        sourceFile: path.resolve(__dirname, 'resources/example.js'),
        targetFile: path.resolve(__dirname, `resources/example${exeSuffix}`),
        addons: [
          {
            path: path.dirname(await pkgUp({ cwd: require.resolve('actual-crash') })),
            requireRegexp: /crash\.node$/
          }
        ]
      });

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`),
          ['typeof require("actual-crash.node").crash'],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, 'function\n');
      }
    });

    it('works with a N-API addon (shard 3)', async function () {
      if (semver.lt(version, '14.13.0')) {
        return this.skip(); // no N-API addon support available
      }

      this.timeout(2 * 60 * 60 * 1000); // 2 hours
      await compileJSFileAsBinary({
        nodeVersionRange: version,
        sourceFile: path.resolve(__dirname, 'resources/example.js'),
        targetFile: path.resolve(__dirname, `resources/example${exeSuffix}`),
        addons: [
          {
            path: path.dirname(await pkgUp({ cwd: require.resolve('weak-napi') })),
            requireRegexp: /weakref\.node$/
          }
        ]
      });

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`),
          ['typeof require("weakref.node").WeakTag'],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, 'function\n');
      }
    });

    it('passes through env vars and runs the pre-compile hook (shard 3)', async function () {
      this.timeout(2 * 60 * 60 * 1000); // 2 hours
      let ranPreCompileHook = false;
      async function preCompileHook (nodeSourceTree: string) {
        ranPreCompileHook = true;
        await fs.access(path.join(nodeSourceTree, 'lib', 'net.js'));
      }
      try {
        await compileJSFileAsBinary({
          nodeVersionRange: version,
          sourceFile: path.resolve(__dirname, 'resources/example.js'),
          targetFile: path.resolve(__dirname, `resources/example${exeSuffix}`),
          env: { CC: 'false', CXX: 'false' },
          preCompileHook
        });
      } catch (err) {
        assert.strictEqual(ranPreCompileHook, true);
        return;
      }

      throw new Error('unreachable');
    });
  });
});
