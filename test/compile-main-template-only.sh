#!/bin/bash

# script to only build the code in resources/
# for CodeQL testing

set -e
set -x
cd "$(dirname $0)/.."
if [ ! -e main-template-build ]; then
  mkdir main-template-build
  pushd main-template-build
  curl -O https://nodejs.org/dist/v24.10.0/node-v24.10.0.tar.xz
  tar --strip-components=1 -xf node-*.tar.xz
  popd
fi

g++ \
  -Imain-template-build/deps/brotli/c/include/ \
  -Imain-template-build/src \
  -Imain-template-build/deps/v8/include \
  -Imain-template-build/deps/uv/include \
  -DREPLACE_DECLARE_LINKED_MODULES= \
  -DREPLACE_DEFINE_LINKED_MODULES= \
  -DREPLACE_WITH_ENTRY_POINT='"placeholder"' \
  -DBOXEDNODE_CODE_CACHE_MODE='"placeholder"' \
  -DREPLACE_WITH_MAIN_SCRIPT_SOURCE_GETTER= \
  -std=c++20 \
  -fPIC -shared \
  -o main-template-build/out.so \
  -include resources/add-node_api.h \
  -include resources/add-node.h \
  resources/main-template.cc
