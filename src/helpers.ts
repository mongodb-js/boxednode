import { promises as fs } from 'fs';
import { Logger } from './logger';
import crypto from 'crypto';
import childProcess from 'child_process';
import { promisify } from 'util';
import tar from 'tar';
import stream from 'stream';
import zlib from 'zlib';
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

export function createCppJsStringDefinition (fnName: string, source: string): string {
  if (!source.length) {
    return `Local<String> ${fnName}(Isolate* isolate) { return String::Empty(isolate); }`;
  }

  const sourceAsCharCodeArray = new Uint16Array(source.length);
  let isAllLatin1 = true;
  for (let i = 0; i < source.length; i++) {
    const charCode = source.charCodeAt(i);
    sourceAsCharCodeArray[i] = charCode;
    isAllLatin1 &&= charCode <= 0xFF;
  }

  return `
  static const ${isAllLatin1 ? 'uint8_t' : 'uint16_t'} ${fnName}_source_[] = {
    ${sourceAsCharCodeArray}
  };
  static_assert(
    ${sourceAsCharCodeArray.length} <= v8::String::kMaxLength,
    "main script source exceeds max string length");
  Local<String> ${fnName}(Isolate* isolate) {
    return v8::String::NewFrom${isAllLatin1 ? 'One' : 'Two'}Byte(
      isolate,
      ${fnName}_source_,
      v8::NewStringType::kNormal,
      ${sourceAsCharCodeArray.length}).ToLocalChecked();
  }
  `;
}

export async function createUncompressedBlobDefinition (fnName: string, source: Uint8Array): Promise<string> {
  return `
  static const uint8_t ${fnName}_source_[] = {
    ${Uint8Array.prototype.toString.call(source) || '0'}
  };

#ifdef NODE_VERSION_SUPPORTS_STRING_VIEW_SNAPSHOT
  std::optional<std::string_view> ${fnName}SV() {
    return {
      {
        reinterpret_cast<const char*>(&${fnName}_source_[0]),
        ${source.length}
      }
    };
  }
#endif

  std::vector<char> ${fnName}Vector() {
    return std::vector<char>(
      reinterpret_cast<const char*>(&${fnName}_source_[0]),
      reinterpret_cast<const char*>(&${fnName}_source_[${source.length}]));
  }

  ${blobTypedArrayAccessors(fnName, source.length)}`;
}

export async function createCompressedBlobDefinition (fnName: string, source: Uint8Array): Promise<string> {
  const compressed = await promisify(zlib.brotliCompress)(source, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: zlib.constants.BROTLI_MAX_QUALITY,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: source.length
    }
  });
  return `
  static const uint8_t ${fnName}_source_[] = {
    ${Uint8Array.prototype.toString.call(compressed) || '0'}
  };

#if __cplusplus >= 201703L
  [[maybe_unused]]
#endif
  static void ${fnName}_Read(char* dst) {
    size_t decoded_size = ${source.length};
    const auto result = BrotliDecoderDecompress(
      ${compressed.length},
      ${fnName}_source_,
      &decoded_size,
      reinterpret_cast<uint8_t*>(&dst[0]));
    assert(result == BROTLI_DECODER_RESULT_SUCCESS);
    assert(decoded_size == ${source.length});
  }

  std::vector<char> ${fnName}Vector() {
    ${source.length === 0 ? 'return {};' : `
    std::vector<char> dst(${source.length});
    ${fnName}_Read(&dst[0]);
    return dst;`}
  }

#ifdef NODE_VERSION_SUPPORTS_STRING_VIEW_SNAPSHOT
  std::optional<std::string_view> ${fnName}SV() {
    return {};
  }
#endif

  ${blobTypedArrayAccessors(fnName, source.length)}
  `;
}

function blobTypedArrayAccessors (fnName: string, sourceLength: number): string {
  return `
  std::shared_ptr<v8::BackingStore> ${fnName}BackingStore() {
    std::vector<char>* str = new std::vector<char>(std::move(${fnName}Vector()));
    return v8::SharedArrayBuffer::NewBackingStore(
      &str->front(),
      str->size(),
      [](void*, size_t, void* deleter_data) {
        delete static_cast<std::vector<char>*>(deleter_data);
      },
      static_cast<void*>(str));
  }

  v8::Local<v8::Uint8Array> ${fnName}Buffer(v8::Isolate* isolate) {
    ${sourceLength === 0 ? `
    auto array_buffer = v8::SharedArrayBuffer::New(isolate, 0);
    ` : `
    auto array_buffer = v8::SharedArrayBuffer::New(isolate, ${fnName}BackingStore());
    `}
    return v8::Uint8Array::New(array_buffer, 0, array_buffer->ByteLength());
  }
  `;
}
