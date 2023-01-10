// This is based on the source code provided as an example in
// https://nodejs.org/api/embedding.html.

#undef NDEBUG

#include "node.h"
#include "node_api.h"
#include "uv.h"
#if HAVE_OPENSSL
#include <openssl/err.h>
#include <openssl/ssl.h>
#include <openssl/bn.h>
#include <openssl/dh.h>
#include <openssl/ec.h>
#include <openssl/rsa.h>
#include <openssl/rand.h>
#endif

using namespace node;
using namespace v8;

// 18.11.0 is the minimum version that has https://github.com/nodejs/node/pull/44121
#if !NODE_VERSION_AT_LEAST(18, 11, 0)
#define USE_OWN_LEGACY_PROCESS_INITIALIZATION 1
#endif

// 18.1.0 is the current minimum version that has https://github.com/nodejs/node/pull/42809,
// which introduced crashes when using workers, and later 18.9.0 is the current
// minimum version to contain https://github.com/nodejs/node/pull/44252, which
// introcued crashes when using the vm module.
// We should be able to remove this restriction again once Node.js stops relying
// on global state for determining whether snapshots are enabled or not
// (after https://github.com/nodejs/node/pull/45888, hopefully).
#if NODE_VERSION_AT_LEAST(18, 1, 0)
#define PASS_NO_NODE_SNAPSHOT_OPTION 1
#endif

#ifdef USE_OWN_LEGACY_PROCESS_INITIALIZATION
namespace boxednode {
void InitializeOncePerProcess();
void TearDownOncePerProcess();
}
#endif
namespace boxednode {
Local<String> GetBoxednodeMainScriptSource(Isolate* isolate);
}

extern "C" {
typedef void (*register_boxednode_linked_module)(const void**, const void**);

REPLACE_DECLARE_LINKED_MODULES
}

static register_boxednode_linked_module boxednode_linked_modules[] = {
  REPLACE_DEFINE_LINKED_MODULES
  nullptr  // Make sure the array is not empty, for MSVC
};

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

  std::shared_ptr<ArrayBufferAllocator> allocator =
      ArrayBufferAllocator::Create();

#if NODE_VERSION_AT_LEAST(14, 0, 0)
  Isolate* isolate = NewIsolate(allocator, loop, platform);
#else
  Isolate* isolate = NewIsolate(allocator.get(), loop, platform);
#endif
  if (isolate == nullptr) {
    fprintf(stderr, "%s: Failed to initialize V8 Isolate\n", args[0].c_str());
    return 1;
  }

  {
    Locker locker(isolate);
    Isolate::Scope isolate_scope(isolate);

    // Create a node::IsolateData instance that will later be released using
    // node::FreeIsolateData().
    std::unique_ptr<IsolateData, decltype(&node::FreeIsolateData)> isolate_data(
        node::CreateIsolateData(isolate, loop, platform, allocator.get()),
        node::FreeIsolateData);

    // Set up a new v8::Context.
    HandleScope handle_scope(isolate);
    Local<Context> context = node::NewContext(isolate);
    if (context.IsEmpty()) {
      fprintf(stderr, "%s: Failed to initialize V8 Context\n", args[0].c_str());
      return 1;
    }

    // The v8::Context needs to be entered when node::CreateEnvironment() and
    // node::LoadEnvironment() are being called.
    Context::Scope context_scope(context);

    // Create a node::Environment instance that will later be released using
    // node::FreeEnvironment().
    std::unique_ptr<Environment, decltype(&node::FreeEnvironment)> env(
        node::CreateEnvironment(isolate_data.get(), context, args, exec_args),
        node::FreeEnvironment);

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

    // Set up the Node.js instance for execution, and run code inside of it.
    // There is also a variant that takes a callback and provides it with
    // the `require` and `process` objects, so that it can manually compile
    // and run scripts as needed.
    // The `require` function inside this script does *not* access the file
    // system, and can only load built-in Node.js modules.
    // `module.createRequire()` is being used to create one that is able to
    // load files from the disk, and uses the standard CommonJS file loader
    // instead of the internal-only `require` function.
    Local<Value> loadenv_ret;
    if (!node::LoadEnvironment(
        env.get(),
        "const path = require('path');\n"
        "if (process.argv[2] === '--') process.argv.splice(2, 1);\n"
        "return require(" REPLACE_WITH_ENTRY_POINT ")").ToLocal(&loadenv_ret)) {
      return 1; // There has been a JS exception.
    }
    assert(loadenv_ret->IsFunction());
    Local<Value> source = boxednode::GetBoxednodeMainScriptSource(isolate);
    if (loadenv_ret.As<Function>()->Call(context, Null(isolate), 1, &source).IsEmpty())
      return 1; // JS exception.

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
  platform->UnregisterIsolate(isolate);
  isolate->Dispose();

  // Wait until the platform has cleaned up all relevant resources.
  while (!platform_finished)
    uv_run(loop, UV_RUN_ONCE);
#ifndef BOXEDNODE_USE_DEFAULT_UV_LOOP
  int err = uv_loop_close(loop);
  assert(err == 0);
#endif

  return exit_code;
}

static int BoxednodeMain(std::vector<std::string> args) {
  std::vector<std::string> exec_args;
  std::vector<std::string> errors;

  if (args.size() > 0) {
    args.insert(args.begin() + 1, "--");
#ifdef PASS_NO_NODE_SNAPSHOT_OPTION
    args.insert(args.begin() + 1, "--no-node-snapshot");
#endif
  }

  // Parse Node.js CLI options, and print any errors that have occurred while
  // trying to parse them.
#ifdef USE_OWN_LEGACY_PROCESS_INITIALIZATION
  boxednode::InitializeOncePerProcess();
  int exit_code = node::InitializeNodeWithArgs(&args, &exec_args, &errors);
  for (const std::string& error : errors)
    fprintf(stderr, "%s: %s\n", args[0].c_str(), error.c_str());
  if (exit_code != 0) {
    return exit_code;
  }
#else
  if (args.size() > 1)
    args.insert(args.begin() + 1, "--openssl-shared-config");
  auto result = node::InitializeOncePerProcess(args, {
    node::ProcessInitializationFlags::kNoInitializeV8,
    node::ProcessInitializationFlags::kNoInitializeNodeV8Platform,
    node::ProcessInitializationFlags::kNoPrintHelpOrVersionOutput
  });
  for (const std::string& error : result->errors())
    fprintf(stderr, "%s: %s\n", args[0].c_str(), error.c_str());
  if (result->exit_code() != 0) {
    return result->exit_code();
  }
  args = result->args();
  exec_args = result->exec_args();
#endif

  // Create a v8::Platform instance. `MultiIsolatePlatform::Create()` is a way
  // to create a v8::Platform instance that Node.js can use when creating
  // Worker threads. When no `MultiIsolatePlatform` instance is present,
  // Worker threads are disabled.
  std::unique_ptr<MultiIsolatePlatform> platform =
      MultiIsolatePlatform::Create(4);
  V8::InitializePlatform(platform.get());
  V8::Initialize();

  // See below for the contents of this function.
  int ret = RunNodeInstance(platform.get(), args, exec_args);

  V8::Dispose();
#ifdef USE_OWN_LEGACY_PROCESS_INITIALIZATION
  V8::ShutdownPlatform();
  boxednode::TearDownOncePerProcess();
#else
  V8::DisposePlatform();
  node::TearDownOncePerProcess();
#endif
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
  return BoxednodeMain(std::move(args));
}
#endif

// The code below is mostly lifted directly from node.cc
#ifdef USE_OWN_LEGACY_PROCESS_INITIALIZATION

#if defined(__APPLE__) || defined(__linux__) || defined(_WIN32)
#define NODE_USE_V8_WASM_TRAP_HANDLER 1
#else
#define NODE_USE_V8_WASM_TRAP_HANDLER 0
#endif

#if NODE_USE_V8_WASM_TRAP_HANDLER
#if defined(_WIN32)
#include "v8-wasm-trap-handler-win.h"
#else
#include <atomic>
#include "v8-wasm-trap-handler-posix.h"
#endif
#endif  // NODE_USE_V8_WASM_TRAP_HANDLER

#if NODE_USE_V8_WASM_TRAP_HANDLER && defined(_WIN32)
static PVOID old_vectored_exception_handler;
#endif

#if defined(_MSC_VER)
#include <direct.h>
#include <io.h>
#define STDIN_FILENO 0
#else
#include <pthread.h>
#include <sys/resource.h>  // getrlimit, setrlimit
#include <termios.h>       // tcgetattr, tcsetattr
#include <unistd.h>        // STDIN_FILENO, STDERR_FILENO
#endif

#include <csignal>
#include <atomic>

namespace boxednode {

#if HAVE_OPENSSL
static void CheckEntropy() {
  for (;;) {
    int status = RAND_status();
    assert(status >= 0);  // Cannot fail.
    if (status != 0)
      break;

    // Give up, RAND_poll() not supported.
    if (RAND_poll() == 0)
      break;
  }
}

static bool EntropySource(unsigned char* buffer, size_t length) {
  // Ensure that OpenSSL's PRNG is properly seeded.
  CheckEntropy();
  // RAND_bytes() can return 0 to indicate that the entropy data is not truly
  // random. That's okay, it's still better than V8's stock source of entropy,
  // which is /dev/urandom on UNIX platforms and the current time on Windows.
  return RAND_bytes(buffer, length) != -1;
}
#endif

void ResetStdio();

#ifdef __POSIX__
static constexpr unsigned kMaxSignal = 32;

typedef void (*sigaction_cb)(int signo, siginfo_t* info, void* ucontext);

void SignalExit(int signo, siginfo_t* info, void* ucontext) {
  ResetStdio();
  raise(signo);
}
#endif

#if NODE_USE_V8_WASM_TRAP_HANDLER
#if defined(_WIN32)
static LONG TrapWebAssemblyOrContinue(EXCEPTION_POINTERS* exception) {
  if (v8::TryHandleWebAssemblyTrapWindows(exception)) {
    return EXCEPTION_CONTINUE_EXECUTION;
  }
  return EXCEPTION_CONTINUE_SEARCH;
}
#else
static std::atomic<sigaction_cb> previous_sigsegv_action;

void TrapWebAssemblyOrContinue(int signo, siginfo_t* info, void* ucontext) {
  if (!v8::TryHandleWebAssemblyTrapPosix(signo, info, ucontext)) {
    sigaction_cb prev = previous_sigsegv_action.load();
    if (prev != nullptr) {
      prev(signo, info, ucontext);
    } else {
      // Reset to the default signal handler, i.e. cause a hard crash.
      struct sigaction sa;
      memset(&sa, 0, sizeof(sa));
      sa.sa_handler = SIG_DFL;
      int ret = sigaction(signo, &sa, nullptr);
      assert(ret == 0);

      ResetStdio();
      raise(signo);
    }
  }
}
#endif  // defined(_WIN32)
#endif  // NODE_USE_V8_WASM_TRAP_HANDLER

#ifdef __POSIX__
void RegisterSignalHandler(int signal,
                           sigaction_cb handler,
                           bool reset_handler) {
  assert(handler != nullptr);
#if NODE_USE_V8_WASM_TRAP_HANDLER
  if (signal == SIGSEGV) {
    assert(previous_sigsegv_action.is_lock_free());
    assert(!reset_handler);
    previous_sigsegv_action.store(handler);
    return;
  }
#endif  // NODE_USE_V8_WASM_TRAP_HANDLER
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_sigaction = handler;
  sa.sa_flags = reset_handler ? SA_RESETHAND : 0;
  sigfillset(&sa.sa_mask);
  int ret = sigaction(signal, &sa, nullptr);
  assert(ret == 0);
}
#endif  // __POSIX__

#ifdef __POSIX__
static struct {
  int flags;
  bool isatty;
  struct stat stat;
  struct termios termios;
} stdio[1 + STDERR_FILENO];
#endif  // __POSIX__


inline void PlatformInit() {
#ifdef __POSIX__
#if HAVE_INSPECTOR
  sigset_t sigmask;
  sigemptyset(&sigmask);
  sigaddset(&sigmask, SIGUSR1);
  const int err = pthread_sigmask(SIG_SETMASK, &sigmask, nullptr);
#endif  // HAVE_INSPECTOR

  // Make sure file descriptors 0-2 are valid before we start logging anything.
  for (auto& s : stdio) {
    const int fd = &s - stdio;
    if (fstat(fd, &s.stat) == 0)
      continue;
    // Anything but EBADF means something is seriously wrong.  We don't
    // have to special-case EINTR, fstat() is not interruptible.
    if (errno != EBADF)
      assert(0);
    if (fd != open("/dev/null", O_RDWR))
      assert(0);
    if (fstat(fd, &s.stat) != 0)
      assert(0);
  }

#if HAVE_INSPECTOR
  CHECK_EQ(err, 0);
#endif  // HAVE_INSPECTOR

  // TODO(addaleax): NODE_SHARED_MODE does not really make sense here.
#ifndef NODE_SHARED_MODE
  // Restore signal dispositions, the parent process may have changed them.
  struct sigaction act;
  memset(&act, 0, sizeof(act));

  // The hard-coded upper limit is because NSIG is not very reliable; on Linux,
  // it evaluates to 32, 34 or 64, depending on whether RT signals are enabled.
  // Counting up to SIGRTMIN doesn't work for the same reason.
  for (unsigned nr = 1; nr < kMaxSignal; nr += 1) {
    if (nr == SIGKILL || nr == SIGSTOP)
      continue;
    act.sa_handler = (nr == SIGPIPE || nr == SIGXFSZ) ? SIG_IGN : SIG_DFL;
    int ret = sigaction(nr, &act, nullptr);
    assert(ret == 0);
  }
#endif  // !NODE_SHARED_MODE

  // Record the state of the stdio file descriptors so we can restore it
  // on exit.  Needs to happen before installing signal handlers because
  // they make use of that information.
  for (auto& s : stdio) {
    const int fd = &s - stdio;
    int err;

    do
      s.flags = fcntl(fd, F_GETFL);
    while (s.flags == -1 && errno == EINTR);  // NOLINT
    assert(s.flags != -1);

    if (uv_guess_handle(fd) != UV_TTY) continue;
    s.isatty = true;

    do
      err = tcgetattr(fd, &s.termios);
    while (err == -1 && errno == EINTR);  // NOLINT
    assert(err == 0);
  }

  RegisterSignalHandler(SIGINT, SignalExit, true);
  RegisterSignalHandler(SIGTERM, SignalExit, true);

#if NODE_USE_V8_WASM_TRAP_HANDLER
#if defined(_WIN32)
  {
    constexpr ULONG first = TRUE;
    old_vectored_exception_handler =
        AddVectoredExceptionHandler(first, TrapWebAssemblyOrContinue);
  }
#else
  // Tell V8 to disable emitting WebAssembly
  // memory bounds checks. This means that we have
  // to catch the SIGSEGV in TrapWebAssemblyOrContinue
  // and pass the signal context to V8.
  {
    struct sigaction sa;
    memset(&sa, 0, sizeof(sa));
    sa.sa_sigaction = TrapWebAssemblyOrContinue;
    sa.sa_flags = SA_SIGINFO;
    int ret = sigaction(SIGSEGV, &sa, nullptr);
    assert(ret == 0);
  }
#endif  // defined(_WIN32)
  V8::EnableWebAssemblyTrapHandler(false);
#endif  // NODE_USE_V8_WASM_TRAP_HANDLER

  // Raise the open file descriptor limit.
  struct rlimit lim;
  if (getrlimit(RLIMIT_NOFILE, &lim) == 0 && lim.rlim_cur != lim.rlim_max) {
    // Do a binary search for the limit.
    rlim_t min = lim.rlim_cur;
    rlim_t max = 1 << 20;
    // But if there's a defined upper bound, don't search, just set it.
    if (lim.rlim_max != RLIM_INFINITY) {
      min = lim.rlim_max;
      max = lim.rlim_max;
    }
    do {
      lim.rlim_cur = min + (max - min) / 2;
      if (setrlimit(RLIMIT_NOFILE, &lim)) {
        max = lim.rlim_cur;
      } else {
        min = lim.rlim_cur;
      }
    } while (min + 1 < max);
  }
#endif  // __POSIX__
#ifdef _WIN32
  for (int fd = 0; fd <= 2; ++fd) {
    auto handle = reinterpret_cast<HANDLE>(_get_osfhandle(fd));
    if (handle == INVALID_HANDLE_VALUE ||
        GetFileType(handle) == FILE_TYPE_UNKNOWN) {
      // Ignore _close result. If it fails or not depends on used Windows
      // version. We will just check _open result.
      _close(fd);
      if (fd != _open("nul", _O_RDWR))
        assert(0);
    }
  }
#endif  // _WIN32
}


// Safe to call more than once and from signal handlers.
void ResetStdio() {
  uv_tty_reset_mode();
#ifdef __POSIX__
  for (auto& s : stdio) {
    const int fd = &s - stdio;

    struct stat tmp;
    if (-1 == fstat(fd, &tmp)) {
      assert(errno == EBADF);  // Program closed file descriptor.
      continue;
    }

    bool is_same_file =
        (s.stat.st_dev == tmp.st_dev && s.stat.st_ino == tmp.st_ino);
    if (!is_same_file) continue;  // Program reopened file descriptor.

    int flags;
    do
      flags = fcntl(fd, F_GETFL);
    while (flags == -1 && errno == EINTR);  // NOLINT
    assert(flags != -1);

    // Restore the O_NONBLOCK flag if it changed.
    if (O_NONBLOCK & (flags ^ s.flags)) {
      flags &= ~O_NONBLOCK;
      flags |= s.flags & O_NONBLOCK;

      int err;
      do
        err = fcntl(fd, F_SETFL, flags);
      while (err == -1 && errno == EINTR);  // NOLINT
      assert(err != -1);
    }

    if (s.isatty) {
      sigset_t sa;
      int err, ret;

      // We might be a background job that doesn't own the TTY so block SIGTTOU
      // before making the tcsetattr() call, otherwise that signal suspends us.
      sigemptyset(&sa);
      sigaddset(&sa, SIGTTOU);

      ret = pthread_sigmask(SIG_BLOCK, &sa, nullptr);
      assert(ret == 0);
      do
        err = tcsetattr(fd, TCSANOW, &s.termios);
      while (err == -1 && errno == EINTR);  // NOLINT
      ret = pthread_sigmask(SIG_UNBLOCK, &sa, nullptr);
      assert(ret == 0);

      // Normally we expect err == 0. But if macOS App Sandbox is enabled,
      // tcsetattr will fail with err == -1 and errno == EPERM.
      if (err != 0) {
        assert(err == -1 && errno == EPERM);
      }
    }
  }
#endif  // __POSIX__
}

static void InitializeOpenSSL() {
#if HAVE_OPENSSL && !defined(OPENSSL_IS_BORINGSSL)
  // In the case of FIPS builds we should make sure
  // the random source is properly initialized first.
#if OPENSSL_VERSION_MAJOR >= 3
  // Use OPENSSL_CONF environment variable is set.
  const char* conf_file = getenv("OPENSSL_CONF");

  OPENSSL_INIT_SETTINGS* settings = OPENSSL_INIT_new();
  OPENSSL_INIT_set_config_filename(settings, conf_file);
  OPENSSL_INIT_set_config_appname(settings, "openssl_conf");
  OPENSSL_INIT_set_config_file_flags(settings,
                                      CONF_MFLAGS_IGNORE_MISSING_FILE);

  OPENSSL_init_crypto(OPENSSL_INIT_LOAD_CONFIG, settings);
  OPENSSL_INIT_free(settings);

  if (ERR_peek_error() != 0) {
    fprintf(stderr, "OpenSSL configuration error:\n");
    ERR_print_errors_fp(stderr);
    exit(1);
  }
#else  // OPENSSL_VERSION_MAJOR < 3
  if (FIPS_mode()) {
    OPENSSL_init();
  }
#endif
  V8::SetEntropySource(boxednode::EntropySource);
#endif
}

void InitializeOncePerProcess() {
  atexit(ResetStdio);
  PlatformInit();
  InitializeOpenSSL();
}

void TearDownOncePerProcess() {
#if NODE_USE_V8_WASM_TRAP_HANDLER && defined(_WIN32)
  RemoveVectoredExceptionHandler(old_vectored_exception_handler);
#endif
}

}  // namespace boxednode

#endif  // USE_OWN_LEGACY_PROCESS_INITIALIZATION

namespace boxednode {
REPLACE_WITH_MAIN_SCRIPT_SOURCE_GETTER
}
