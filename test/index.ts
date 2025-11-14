import { compileJSFileAsBinary } from '..';
import path from 'path';
import os from 'os';
import assert from 'assert';
import childProcess from 'child_process';
import { promisify } from 'util';
import pkgUp from 'pkg-up';
import { promises as fs } from 'fs';

const execFile = promisify(childProcess.execFile);
const exeSuffix = process.platform === 'win32' ? '.exe' : '';

// we are using 4h because compiling in windows might take more time
const DEFAULT_TIMEOUT = 4 * 60 * 60 * 1000;

describe('basic functionality', () => {
  // Test the currently running Node.js version. Other versions can be checked
  // manually that way, or through the CI matrix.
  const version = process.env.TEST_NODE_VERSION || process.version.slice(1).replace(/-.*$/, '');

  describe(`On Node v${version}`, function () {
    it('works in a simple case', async function () {
      this.timeout(DEFAULT_TIMEOUT);
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
          path.resolve(__dirname, `resources/example${exeSuffix}`), ['"🐈"'],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, '🐈\n');
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

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), ['require("vm").runInNewContext("21*2")'],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, '42\n');
      }

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), ['JSON.stringify(process.boxednode)'],
          { encoding: 'utf8' });
        const parsed = JSON.parse(stdout);
        assert.strictEqual(parsed.hasCodeCache, false);
        assert([false, undefined].includes(parsed.rejectedCodeCache));
      }

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), [
            'new (require("worker_threads").Worker)' +
              '("require(`worker_threads`).parentPort.postMessage(21*2)", {eval:true})' +
              '.once("message", console.log);0'
          ],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, '0\n42\n');
      }

      if (process.platform !== 'win32') {
        const proc = childProcess.spawn(
          path.resolve(__dirname, `resources/example${exeSuffix}`),
          ['process.title = "bananananana"; setInterval(() => {}, 1000);']);

        const { stdout } = await execFile('ps', ['aux'], { encoding: 'utf8' });
        assert(stdout.includes('bananananana'), `Missed process.title change in ${stdout}`);
        proc.kill();
      }

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), [
            'process.boxednode.markTime("Whatever", "running js");JSON.stringify(process.boxednode.getTimingData())'
          ],
          { encoding: 'utf8' });
        const timingData = JSON.parse(stdout);
        assert.strictEqual(timingData[0][0], 'Node.js Instance');
        assert.strictEqual(timingData[0][1], 'Process initialization');
        assert.strictEqual(timingData[timingData.length - 1][0], 'Whatever');
        assert.strictEqual(timingData[timingData.length - 1][1], 'running js');
      }
    });

    it('works with a Nan addon', async function () {
      this.timeout(DEFAULT_TIMEOUT);
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

    it('works with a N-API addon', async function () {
      this.timeout(DEFAULT_TIMEOUT);
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

    it('passes through env vars and runs the pre-compile hook', async function () {
      this.timeout(DEFAULT_TIMEOUT);
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

    it('works with code caching support', async function () {
      this.timeout(DEFAULT_TIMEOUT);
      await compileJSFileAsBinary({
        nodeVersionRange: version,
        sourceFile: path.resolve(__dirname, 'resources/example.js'),
        targetFile: path.resolve(__dirname, `resources/example${exeSuffix}`),
        useCodeCache: true
      });

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), [],
          { encoding: 'utf8' });
        assert.strictEqual(stdout, 'Hello world!\n');
      }

      {
        const { stdout } = await execFile(
          path.resolve(__dirname, `resources/example${exeSuffix}`), ['JSON.stringify(process.boxednode)'],
          { encoding: 'utf8' });
        const parsed = JSON.parse(stdout);
        assert.strictEqual(parsed.hasCodeCache, true);
        assert([false, undefined].includes(parsed.rejectedCodeCache));
      }
    });

    for (const compressBlobs of [false, true]) {
      it(`works with snapshot support (compressBlobs = ${compressBlobs})`, async function () {
        this.timeout(DEFAULT_TIMEOUT);
        await compileJSFileAsBinary({
          nodeVersionRange: version,
          sourceFile: path.resolve(__dirname, 'resources/snapshot-echo-args.js'),
          targetFile: path.resolve(__dirname, `resources/snapshot-echo-args${exeSuffix}`),
          useNodeSnapshot: true,
          compressBlobs,
          nodeSnapshotConfigFlags: ['WithoutCodeCache'],
          // the nightly path name is too long for Windows...
          tmpdir: process.platform === 'win32' ? path.join(os.tmpdir(), 'bn') : undefined
        });

        {
          const { stdout } = await execFile(
            path.resolve(__dirname, `resources/snapshot-echo-args${exeSuffix}`), ['a', 'b', 'c'],
            { encoding: 'utf8' });
          const { currentArgv, originalArgv, timingData } = JSON.parse(stdout);
          assert(currentArgv[0].includes('snapshot-echo-args'));
          assert(currentArgv[1].includes('snapshot-echo-args'));
          assert.deepStrictEqual(currentArgv.slice(2), ['a', 'b', 'c']);
          assert.strictEqual(originalArgv.length, 2); // [execPath, execPath]
          assert.strictEqual(timingData[0][0], 'Node.js Instance');
          assert.strictEqual(timingData[0][1], 'Process initialization');
        }
      });
    }
  });
});
