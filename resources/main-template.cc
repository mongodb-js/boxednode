// This is based on the source code provided as an example in
// https://nodejs.org/api/embedding.html.

#undef NDEBUG

#include "node.h"
#include "uv.h"

using namespace node;
using namespace v8;

namespace boxednode {
void InitializeOncePerProcess();
void TearDownOncePerProcess();
}

static int RunNodeInstance(MultiIsolatePlatform* platform,
                           const std::vector<std::string>& args,
                           const std::vector<std::string>& exec_args) {
  int exit_code = 0;
  // Set up a libuv event loop.
  uv_loop_t loop;
  int ret = uv_loop_init(&loop);
  if (ret != 0) {
    fprintf(stderr, "%s: Failed to initialize loop: %s\n",
            args[0].c_str(),
            uv_err_name(ret));
    return 1;
  }

  std::shared_ptr<ArrayBufferAllocator> allocator =
      ArrayBufferAllocator::Create();

  Isolate* isolate = NewIsolate(allocator, &loop, platform);
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
        node::CreateIsolateData(isolate, &loop, platform, allocator.get()),
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

    // Set up the Node.js instance for execution, and run code inside of it.
    // There is also a variant that takes a callback and provides it with
    // the `require` and `process` objects, so that it can manually compile
    // and run scripts as needed.
    // The `require` function inside this script does *not* access the file
    // system, and can only load built-in Node.js modules.
    // `module.createRequire()` is being used to create one that is able to
    // load files from the disk, and uses the standard CommonJS file loader
    // instead of the internal-only `require` function.
    MaybeLocal<Value> loadenv_ret = node::LoadEnvironment(
        env.get(),
        "const path = require('path');\n"
        "if (process.argv[2] === '--') process.argv.splice(2, 1);\n"
        "require(" REPLACE_WITH_ENTRY_POINT ")");

    if (loadenv_ret.IsEmpty())  // There has been a JS exception.
      return 1;

    {
      // SealHandleScope protects against handle leaks from callbacks.
      SealHandleScope seal(isolate);
      bool more;
      do {
        uv_run(&loop, UV_RUN_DEFAULT);

        // V8 tasks on background threads may end up scheduling new tasks in the
        // foreground, which in turn can keep the event loop going. For example,
        // WebAssembly.compile() may do so.
        platform->DrainTasks(isolate);

        // If there are new tasks, continue.
        more = uv_loop_alive(&loop);
        if (more) continue;

        // node::EmitBeforeExit() is used to emit the 'beforeExit' event on
        // the `process` object.
        node::EmitBeforeExit(env.get());

        // 'beforeExit' can also schedule new work that keeps the event loop
        // running.
        more = uv_loop_alive(&loop);
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
    uv_run(&loop, UV_RUN_ONCE);
  int err = uv_loop_close(&loop);
  assert(err == 0);

  return exit_code;
}

int main(int argc, char** argv) {
  boxednode::InitializeOncePerProcess();
  argv = uv_setup_args(argc, argv);
  std::vector<std::string> args(argv, argv + argc);
  std::vector<std::string> exec_args;
  std::vector<std::string> errors;

  args.insert(args.begin(), "--");

  // Parse Node.js CLI options, and print any errors that have occurred while
  // trying to parse them.
  int exit_code = node::InitializeNodeWithArgs(&args, &exec_args, &errors);
  for (const std::string& error : errors)
    fprintf(stderr, "%s: %s\n", args[0].c_str(), error.c_str());
  if (exit_code != 0) {
    return exit_code;
  }

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
  V8::ShutdownPlatform();
  boxednode::TearDownOncePerProcess();
  return ret;
}

// The code below is mostly lifted directly from node.cc
// TODO(addaleax): Expose these APIs on the Node.js side.

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

void InitializeOncePerProcess() {
  atexit(ResetStdio);
  PlatformInit();
}

void TearDownOncePerProcess() {
#if NODE_USE_V8_WASM_TRAP_HANDLER && defined(_WIN32)
  RemoveVectoredExceptionHandler(old_vectored_exception_handler);
#endif
}

}  // namespace boxednode
