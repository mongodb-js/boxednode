#ifdef BUILDING_BOXEDNODE_EXTENSION

#undef EXTERN_C_START
#undef EXTERN_C_END
#ifdef __cplusplus
#define EXTERN_C_START extern "C" {
#define EXTERN_C_END }
#else
#define EXTERN_C_START
#define EXTERN_C_END
#endif

#ifndef NODE_STRINGIFY
# define NODE_STRINGIFY(n) NODE_STRINGIFY_HELPER(n)
# define NODE_STRINGIFY_HELPER(n) #n
#endif

#undef NAPI_MODULE_X
#define NAPI_MODULE_X(modname, regfunc, priv, flags)                  \
  EXTERN_C_START                                                      \
    static napi_module _module =                                      \
    {                                                                 \
      NAPI_MODULE_VERSION,                                            \
      flags,                                                          \
      __FILE__,                                                       \
      regfunc,                                                        \
      NODE_STRINGIFY(BOXEDNODE_MODULE_NAME),                          \
      priv,                                                           \
      {0},                                                            \
    };                                                                \
    void BOXEDNODE_REGISTER_FUNCTION(                                 \
        const void**, const void** napi_mod) {                        \
      *napi_mod = &_module;                                           \
    }                                                                 \
  EXTERN_C_END

#undef NAPI_MODULE_INITIALIZER_X
#define NAPI_MODULE_INITIALIZER_X(base, version)                               \
  NAPI_MODULE_INITIALIZER_X_HELPER(base, version)
#undef NAPI_MODULE_INITIALIZER_X_HELPER
#define NAPI_MODULE_INITIALIZER_X_HELPER(base, version) base##version

#undef NAPI_MODULE
#define NAPI_MODULE(modname, regfunc)                                 \
  NAPI_MODULE_X(modname, regfunc, NULL, 0x2)

#undef NAPI_MODULE_INITIALIZER_BASE
#define NAPI_MODULE_INITIALIZER_BASE napi_register_module_v

#undef NAPI_MODULE_INITIALIZER
#define NAPI_MODULE_INITIALIZER                                       \
  NAPI_MODULE_INITIALIZER_X(NAPI_MODULE_INITIALIZER_BASE,             \
      NAPI_MODULE_VERSION)

#undef NAPI_MODULE_INIT
#define NAPI_MODULE_INIT()                                            \
  EXTERN_C_START                                                      \
  NAPI_MODULE_EXPORT napi_value                                       \
  NAPI_MODULE_INITIALIZER(napi_env env, napi_value exports);          \
  EXTERN_C_END                                                        \
  NAPI_MODULE(NODE_GYP_MODULE_NAME, NAPI_MODULE_INITIALIZER)          \
  napi_value NAPI_MODULE_INITIALIZER(napi_env env,                    \
                                     napi_value exports)

#endif  // BUILDING_BOXEDNODE_EXTENSION
