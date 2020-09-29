import { compileJSFileAsBinary } from '..';
import path from 'path';
import assert from 'assert';
import childProcess from 'child_process';
import { promisify } from 'util';

const execFile = promisify(childProcess.execFile);
const exeSuffix = process.platform === 'win32' ? '.exe' : '';

describe('basic functionality', () => {
  // Test the currently running Node.js version. Other versions can be checked
  // manually that way, or through the CI matrix.
  const version = process.version.slice(1).split('.')[0];

  it(`works on Node v${version}`, async function () {
    this.timeout(2 * 60 * 60 * 1000); // 2 hours
    await compileJSFileAsBinary({
      nodeVersionRange: `^${version}.0.0`,
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

    if (process.platform !== 'win32') {
      const proc = childProcess.spawn(
        path.resolve(__dirname, `resources/example${exeSuffix}`),
        ['process.title = "bananananana"; setInterval(() => {}, 1000);']);

      const { stdout } = await execFile('ps', ['aux'], { encoding: 'utf8' });
      assert(stdout.includes('bananananana'), `Missed process.title change in ${stdout}`);
      proc.kill();
    }
  });

  it('passes through env vars', async function () {
    this.timeout(2 * 60 * 60 * 1000); // 2 hours
    try {
      await compileJSFileAsBinary({
        nodeVersionRange: '^12.0.0',
        sourceFile: path.resolve(__dirname, 'resources/example.js'),
        targetFile: path.resolve(__dirname, `resources/example${exeSuffix}`),
        env: { CC: 'false', CXX: 'false' }
      });
    } catch (err) {
      return;
    }

    throw new Error('unreachable');
  });
});
