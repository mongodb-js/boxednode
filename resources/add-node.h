#ifdef BUILDING_BOXEDNODE_EXTENSION
#undef NODE_MODULE_X
#define NODE_MODULE_X(modname, regfunc, priv, flags)                  \
  extern "C" {                                                        \
    static node::node_module _module =                                \
    {                                                                 \
      NODE_MODULE_VERSION,                                            \
      flags,                                                          \
      NULL,  /* NOLINT (readability/null_usage) */                    \
      __FILE__,                                                       \
      (node::addon_register_func) (regfunc),                          \
      NULL,  /* NOLINT (readability/null_usage) */                    \
      NODE_STRINGIFY(BOXEDNODE_MODULE_NAME),                          \
      priv,                                                           \
      NULL   /* NOLINT (readability/null_usage) */                    \
    };                                                                \
    void BOXEDNODE_REGISTER_FUNCTION(                                 \
        const void** node_mod, const void**) {                        \
      *node_mod = &_module;                                           \
    }                                                                 \
  }

#undef NODE_MODULE_CONTEXT_AWARE_X
#define NODE_MODULE_CONTEXT_AWARE_X(modname, regfunc, priv, flags)    \
  extern "C" {                                                        \
    static node::node_module _module =                                \
    {                                                                 \
      NODE_MODULE_VERSION,                                            \
      flags,                                                          \
      NULL,  /* NOLINT (readability/null_usage) */                    \
      __FILE__,                                                       \
      NULL,  /* NOLINT (readability/null_usage) */                    \
      (node::addon_context_register_func) (regfunc),                  \
      NODE_STRINGIFY(BOXEDNODE_MODULE_NAME),                          \
      priv,                                                           \
      NULL  /* NOLINT (readability/null_usage) */                     \
    };                                                                \
    void BOXEDNODE_REGISTER_FUNCTION(                                 \
        const void** node_mod, const void**) {                        \
      *node_mod = &_module;                                           \
    }                                                                 \
  }

#undef NODE_MODULE
#define NODE_MODULE(modname, regfunc)                                 \
  NODE_MODULE_X(modname, regfunc, NULL, 0x2)

#undef NODE_MODULE_CONTEXT_AWARE
#define NODE_MODULE_CONTEXT_AWARE(modname, regfunc)                   \
  NODE_MODULE_CONTEXT_AWARE_X(modname, regfunc, NULL, 0x2)

#undef NODE_MODULE_DECL
#define NODE_MODULE_DECL /* nothing */

#undef NODE_MODULE_INITIALIZER_BASE
#define NODE_MODULE_INITIALIZER_BASE node_register_module_v

#undef NODE_MODULE_INITIALIZER_X
#define NODE_MODULE_INITIALIZER_X(base, version)                      \
    NODE_MODULE_INITIALIZER_X_HELPER(base, version)

#undef NODE_MODULE_INITIALIZER_X_HELPER
#define NODE_MODULE_INITIALIZER_X_HELPER(base, version) base##version

#undef NODE_MODULE_INITIALIZER
#define NODE_MODULE_INITIALIZER                                       \
  NODE_MODULE_INITIALIZER_X(NODE_MODULE_INITIALIZER_BASE,             \
      NODE_MODULE_VERSION)

#undef NODE_MODULE_INIT
#define NODE_MODULE_INIT()                                            \
  extern "C" NODE_MODULE_EXPORT void                                  \
  NODE_MODULE_INITIALIZER(v8::Local<v8::Object> exports,              \
                          v8::Local<v8::Value> module,                \
                          v8::Local<v8::Context> context);            \
  NODE_MODULE_CONTEXT_AWARE(NODE_GYP_MODULE_NAME,                     \
                            NODE_MODULE_INITIALIZER)                  \
  void NODE_MODULE_INITIALIZER(v8::Local<v8::Object> exports,         \
                               v8::Local<v8::Value> module,           \
                               v8::Local<v8::Context> context)

#endif  // BUILDING_BOXEDNODE_EXTENSION
