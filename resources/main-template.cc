// This is based on the source code provided as an example in
// https://nodejs.org/api/embedding.html.

#undef NDEBUG

#include "node.h"
#include "node_api.h"
#include "uv.h"
#include "brotli/decode.h"
#include <atomic>
#if HAVE_OPENSSL
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/bn.h>
#include <openssl/dh.h>
#include <openssl/ec.h>
#include <openssl/rsa.h>
#include <openssl/rand.h>
#endif
#include <type_traits> // injected code may refer to std::underlying_type
#include <optional>

using namespace node;
using namespace v8;

// Snapshot config is supported since https://github.com/nodejs/node/pull/50453
#ifndef BOXEDNODE_SNAPSHOT_CONFIG_FLAGS
#define BOXEDNODE_SNAPSHOT_CONFIG_FLAGS (SnapshotFlags::kWithoutCodeCache)
#endif

namespace boxednode {
namespace {
struct TimingEntry {
  const char* const category;
  const char* const label;
  uint64_t const time;
  TimingEntry* next = nullptr;
  ~TimingEntry() {
    delete next;
  }
};
TimingEntry start_time_entry { "Node.js Instance", "Process initialization", uv_hrtime() };
std::atomic<TimingEntry*> current_time_entry { &start_time_entry };

void MarkTime(const char* category, const char* label) {
  TimingEntry* new_entry = new TimingEntry {category, label, uv_hrtime() };
  do {
    new_entry->next = current_time_entry.load();
  } while(!current_time_entry.compare_exchange_strong(new_entry->next, new_entry));
}
} // anonymous namespace

Local<String> GetBoxednodeMainScriptSource(Isolate* isolate);
Local<Uint8Array> GetBoxednodeCodeCacheBuffer(Isolate* isolate);
std::vector<char> GetBoxednodeSnapshotBlobVector();
std::optional<std::string_view> GetBoxednodeSnapshotBlobSV();

void GetTimingData(const FunctionCallbackInfo<Value>& info) {
  Isolate* isolate = info.GetIsolate();
  TimingEntry* head = current_time_entry.load();
  std::vector<Local<Value>> entries;
  while (head != nullptr) {
    Local<Value> elements[] = {
      String::NewFromUtf8(isolate, head->category).ToLocalChecked(),
      String::NewFromUtf8(isolate, head->label).ToLocalChecked(),
      BigInt::NewFromUnsigned(isolate, head->time)
    };
    entries.push_back(Array::New(isolate, elements, sizeof(elements)/sizeof(elements[0])));
    head = head->next;
  }
  Local<Array> retval = Array::New(isolate, entries.data(), entries.size());
  info.GetReturnValue().Set(retval);
}

void boxednode_linked_bindings_register(
    Local<Object> exports,
    Local<Value> module,
    Local<Context> context,
    void* priv) {
  NODE_SET_METHOD(exports, "getTimingData", GetTimingData);
}

}

extern "C" {
typedef void (*register_boxednode_linked_module)(const void**, const void**);

REPLACE_DECLARE_LINKED_MODULES
}

#if __cplusplus >= 201703L
[[maybe_unused]]
#endif
static register_boxednode_linked_module boxednode_linked_modules[] = {
  REPLACE_DEFINE_LINKED_MODULES
  nullptr  // Make sure the array is not empty, for MSVC
};

static MaybeLocal<Value> LoadBoxednodeEnvironment(Local<Context> context) {
  Environment* env = GetCurrentEnvironment(context);
  return LoadEnvironment(env,
#ifdef BOXEDNODE_CONSUME_SNAPSHOT
        node::StartExecutionCallback{}
#else
        [&](const StartExecutionCallbackInfo& info) -> MaybeLocal<Value> {
          Isolate* isolate = context->GetIsolate();
          HandleScope handle_scope(isolate);
          Local<Value> entrypoint_name = String::NewFromUtf8(
              isolate,
              REPLACE_WITH_ENTRY_POINT)
              .ToLocalChecked();
          Local<Value> entrypoint_ret;
          if (!info.native_require->Call(
              context,
              Null(isolate),
              1,
              &entrypoint_name
            ).ToLocal(&entrypoint_ret)) {
            return {}; // JS exception.
          }
          assert(entrypoint_ret->IsFunction());
          Local<Value> trampoline_args[] = {
            boxednode::GetBoxednodeMainScriptSource(isolate),
            String::NewFromUtf8Literal(isolate, BOXEDNODE_CODE_CACHE_MODE),
            boxednode::GetBoxednodeCodeCacheBuffer(isolate),
          };
          boxednode::MarkTime("Node.js Instance", "Calling entrypoint");
          if (entrypoint_ret.As<Function>()->Call(
              context,
              Null(isolate),
              sizeof(trampoline_args) / sizeof(trampoline_args[0]),
              trampoline_args).IsEmpty()) {
            return {}; // JS exception.
          }
          boxednode::MarkTime("Node.js Instance", "Called entrypoint");
          return Null(isolate);
      }
#endif
    );
}

#ifdef BOXEDNODE_GENERATE_SNAPSHOT
static int RunNodeInstance(MultiIsolatePlatform* platform,
                           const std::vector<std::string>& args,
                           const std::vector<std::string>& exec_args) {
  int exit_code = 0;
  std::vector<std::string> errors;
  std::unique_ptr<CommonEnvironmentSetup> setup =
      CommonEnvironmentSetup::CreateForSnapshotting(
          platform,
          &errors,
          args,
          exec_args,
          SnapshotConfig { BOXEDNODE_SNAPSHOT_CONFIG_FLAGS, std::nullopt }
          );

  Isolate* isolate = setup->isolate();
  Locker locker(isolate);

  {
    Isolate::Scope isolate_scope(isolate);

    HandleScope handle_scope(isolate);
    Local<Context> context = setup->context();
    Context::Scope context_scope(context);
    if (LoadBoxednodeEnvironment(context).IsEmpty())
      return 1;
    exit_code = SpinEventLoop(setup->env()).FromMaybe(1);
  }

  {
    FILE* fp = fopen("intermediate.out", "wb");
    setup->CreateSnapshot()->ToFile(fp);
    fclose(fp);
  }
  return exit_code;
}
#else // BOXEDNODE_GENERATE_SNAPSHOT
static int RunNodeInstance(MultiIsolatePlatform* platform,
                           const std::vector<std::string>& args,
                           const std::vector<std::string>& exec_args) {
  int exit_code = 0;
  uv_loop_t* loop;
#ifndef BOXEDNODE_USE_DEFAULT_UV_LOOP
  // Set up a libuv event loop.
  uv_loop_t loop_;
  loop = &loop_;
  int ret = uv_loop_init(loop);
  if (ret != 0) {
    fprintf(stderr, "%s: Failed to initialize loop: %s\n",
            args[0].c_str(),
            uv_err_name(ret));
    return 1;
  }
#else
  loop = uv_default_loop();
#endif
  boxednode::MarkTime("Node.js Instance", "Initialized Loop");

  std::shared_ptr<ArrayBufferAllocator> allocator =
      ArrayBufferAllocator::Create();

#ifdef BOXEDNODE_CONSUME_SNAPSHOT
  node::EmbedderSnapshotData::Pointer snapshot_blob;
  if (const auto snapshot_blob_sv = boxednode::GetBoxednodeSnapshotBlobSV()) {
    snapshot_blob = EmbedderSnapshotData::FromBlob(snapshot_blob_sv.value());
  }
  if (!snapshot_blob) {
    std::vector<char> snapshot_blob_vec = boxednode::GetBoxednodeSnapshotBlobVector();
    boxednode::MarkTime("Node.js Instance", "Decoded snapshot");
    snapshot_blob = EmbedderSnapshotData::FromBlob(snapshot_blob_vec);
  }
  boxednode::MarkTime("Node.js Instance", "Read snapshot");
  Isolate* isolate = NewIsolate(allocator, loop, platform, snapshot_blob.get());
#elif NODE_VERSION_AT_LEAST(14, 0, 0)
  Isolate* isolate = NewIsolate(allocator, loop, platform);
#else
  Isolate* isolate = NewIsolate(allocator.get(), loop, platform);
#endif
  if (isolate == nullptr) {
    fprintf(stderr, "%s: Failed to initialize V8 Isolate\n", args[0].c_str());
    return 1;
  }
  boxednode::MarkTime("Node.js Instance", "Created Isolate");

  {
    Locker locker(isolate);
    Isolate::Scope isolate_scope(isolate);

    // Create a node::IsolateData instance that will later be released using
    // node::FreeIsolateData().
    std::unique_ptr<IsolateData, decltype(&node::FreeIsolateData)> isolate_data(
        node::CreateIsolateData(isolate, loop, platform, allocator.get()
#ifdef BOXEDNODE_CONSUME_SNAPSHOT
        , snapshot_blob.get()
#endif
        ),
        node::FreeIsolateData);

    boxednode::MarkTime("Node.js Instance", "Created IsolateData");
    HandleScope handle_scope(isolate);
    Local<Context> context;
#ifndef BOXEDNODE_CONSUME_SNAPSHOT
    // Set up a new v8::Context.
    context = node::NewContext(isolate);

    if (context.IsEmpty()) {
      fprintf(stderr, "%s: Failed to initialize V8 Context\n", args[0].c_str());
      return 1;
    }

    // The v8::Context needs to be entered when node::CreateEnvironment() and
    // node::LoadEnvironment() are being called.
    Context::Scope context_scope(context);
#endif
    boxednode::MarkTime("Node.js Instance", "Created Context");

    // Create a node::Environment instance that will later be released using
    // node::FreeEnvironment().
    std::unique_ptr<Environment, decltype(&node::FreeEnvironment)> env(
        node::CreateEnvironment(isolate_data.get(), context, args, exec_args),
        node::FreeEnvironment);
#ifdef BOXEDNODE_CONSUME_SNAPSHOT
    assert(context.IsEmpty());
    context = GetMainContext(env.get());
    assert(!context.IsEmpty());
    Context::Scope context_scope(context);
#endif
    assert(isolate->InContext());
    boxednode::MarkTime("Node.js Instance", "Created Environment");

    const void* node_mod;
    const void* napi_mod;

    for (register_boxednode_linked_module reg : boxednode_linked_modules) {
      if (reg == nullptr) continue;
      node_mod = nullptr;
      napi_mod = nullptr;
      reg(&node_mod, &napi_mod);
      if (node_mod != nullptr)
        AddLinkedBinding(env.get(), *static_cast<const node_module*>(node_mod));
#if NODE_VERSION_AT_LEAST(14, 13, 0)
      if (napi_mod != nullptr)
        AddLinkedBinding(env.get(), *static_cast<const napi_module*>(napi_mod));
#endif
    }
    AddLinkedBinding(
        env.get(),
        "boxednode_linked_bindings",
        boxednode::boxednode_linked_bindings_register, nullptr);
    boxednode::MarkTime("Boxednode Binding", "Added bindings");

    // Set up the Node.js instance for execution, and run code inside of it.
    // There is also a variant that takes a callback and provides it with
    // the `require` and `process` objects, so that it can manually compile
    // and run scripts as needed.
    // The `require` function inside this script does *not* access the file
    // system, and can only load built-in Node.js modules.
    // `module.createRequire()` is being used to create one that is able to
    // load files from the disk, and uses the standard CommonJS file loader
    // instead of the internal-only `require` function.
    if (LoadBoxednodeEnvironment(context).IsEmpty()) {
      return 1; // There has been a JS exception.
    }
    boxednode::MarkTime("Boxednode Binding", "Loaded Environment, entering loop");

    {
      // SealHandleScope protects against handle leaks from callbacks.
      SealHandleScope seal(isolate);
      bool more;
      do {
        uv_run(loop, UV_RUN_DEFAULT);

        // V8 tasks on background threads may end up scheduling new tasks in the
        // foreground, which in turn can keep the event loop going. For example,
        // WebAssembly.compile() may do so.
        platform->DrainTasks(isolate);

        // If there are new tasks, continue.
        more = uv_loop_alive(loop);
        if (more) continue;

        // node::EmitBeforeExit() is used to emit the 'beforeExit' event on
        // the `process` object.
        node::EmitBeforeExit(env.get());

        // 'beforeExit' can also schedule new work that keeps the event loop
        // running.
        more = uv_loop_alive(loop);
      } while (more == true);
    }

    // node::EmitExit() returns the current exit code.
    exit_code = node::EmitExit(env.get());

    // node::Stop() can be used to explicitly stop the event loop and keep
    // further JavaScript from running. It can be called from any thread,
    // and will act like worker.terminate() if called from another thread.
    node::Stop(env.get());
  }

  // Unregister the Isolate with the platform and add a listener that is called
  // when the Platform is done cleaning up any state it had associated with
  // the Isolate.
  bool platform_finished = false;
  platform->AddIsolateFinishedCallback(isolate, [](void* data) {
    *static_cast<bool*>(data) = true;
  }, &platform_finished);

  // https://github.com/nodejs/node/commit/5d3e1b555c0902db1e99577a3429cffedcf3bbdc
#if NODE_VERSION_AT_LEAST(24, 0, 0)
  platform->DisposeIsolate(isolate);
#else
  isolate->Dispose();
  platform->UnregisterIsolate(isolate);
#endif

  // Wait until the platform has cleaned up all relevant resources.
  while (!platform_finished)
    uv_run(loop, UV_RUN_ONCE);
#ifndef BOXEDNODE_USE_DEFAULT_UV_LOOP
  int err = uv_loop_close(loop);
  assert(err == 0);
#endif

  return exit_code;
}
#endif // BOXEDNODE_GENERATE_SNAPSHOT

static int BoxednodeMain(std::vector<std::string> args) {
  std::vector<std::string> exec_args;
  std::vector<std::string> errors;

  if (args.size() > 0) {
      args.insert(args.begin() + 1, "--");
  }

  // Parse Node.js CLI options, and print any errors that have occurred while
  // trying to parse them.
#if OPENSSL_VERSION_MAJOR >= 3
  if (args.size() > 1)
    args.insert(args.begin() + 1, "--openssl-shared-config");
#endif
  boxednode::MarkTime("Node.js Instance", "Start InitializeOncePerProcess");
  auto result = node::InitializeOncePerProcess(args, {
    node::ProcessInitializationFlags::kNoInitializeV8,
    node::ProcessInitializationFlags::kNoInitializeNodeV8Platform,
    node::ProcessInitializationFlags::kNoPrintHelpOrVersionOutput
  });
  boxednode::MarkTime("Node.js Instance", "Finished InitializeOncePerProcess");
  for (const std::string& error : result->errors())
    fprintf(stderr, "%s: %s\n", args[0].c_str(), error.c_str());
  if (result->exit_code() != 0) {
    return result->exit_code();
  }
  args = result->args();
  exec_args = result->exec_args();

#ifdef BOXEDNODE_CONSUME_SNAPSHOT
  if (args.size() > 0) {
    args.insert(args.begin() + 1, "--boxednode-snapshot-argv-fixup");
  }
#endif

  // Create a v8::Platform instance. `MultiIsolatePlatform::Create()` is a way
  // to create a v8::Platform instance that Node.js can use when creating
  // Worker threads. When no `MultiIsolatePlatform` instance is present,
  // Worker threads are disabled.
  std::unique_ptr<MultiIsolatePlatform> platform =
      MultiIsolatePlatform::Create(4);
  V8::InitializePlatform(platform.get());
  V8::Initialize();

  boxednode::MarkTime("Node.js Instance", "Initialized V8");
  // See below for the contents of this function.
  int ret = RunNodeInstance(platform.get(), args, exec_args);

  V8::Dispose();
  V8::DisposePlatform();
  node::TearDownOncePerProcess();
  return ret;
}

#ifdef _WIN32
int wmain(int argc, wchar_t* wargv[]) {
  // Convert argv to UTF8
  std::vector<std::string> args;
  for (int i = 0; i < argc; i++) {
    DWORD size = WideCharToMultiByte(CP_UTF8,
                                     0,
                                     wargv[i],
                                     -1,
                                     nullptr,
                                     0,
                                     nullptr,
                                     nullptr);
    assert(size > 0);
    std::string arg(size, '\0');
    DWORD result = WideCharToMultiByte(CP_UTF8,
                                       0,
                                       wargv[i],
                                       -1,
                                       &arg[0],
                                       size,
                                       nullptr,
                                       nullptr);
    assert(result > 0);
    arg.resize(result - 1);
    args.emplace_back(std::move(arg));
  }
  return BoxednodeMain(std::move(args));
}

#else
int main(int argc, char** argv) {
  argv = uv_setup_args(argc, argv);
  std::vector<std::string> args(argv, argv + argc);
  boxednode::MarkTime("Node.js Instance", "Enter BoxednodeMain");
  return BoxednodeMain(std::move(args));
}
#endif

namespace boxednode {
REPLACE_WITH_MAIN_SCRIPT_SOURCE_GETTER
}
