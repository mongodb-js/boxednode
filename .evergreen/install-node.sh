#!/bin/bash
# adapted from the Node.js driver's script for installing Node.js
set -e
set -x

export BASEDIR="$PWD"
mkdir -p .deps
cd .deps

NVM_URL="https://raw.githubusercontent.com/nvm-sh/nvm/v0.38.0/install.sh"

# this needs to be explicitly exported for the nvm install below
export NVM_DIR="$PWD/nvm"
export XDG_CONFIG_HOME=$PWD

# install Node.js on Windows
if [[ "$OS" == "Windows_NT" ]]; then
  curl -o node.zip "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-win-x64.zip"
  unzip node.zip
  mkdir -p node/bin
  mv -v node-v$NODE_VERSION-win-x64/* node/bin
  chmod a+x node/bin/*
  export PATH="$PWD/node/bin:$PATH"
# install Node.js on Linux/MacOS
else
  curl -o- $NVM_URL | bash
  set +x
  [ -s "${NVM_DIR}/nvm.sh" ] && source "${NVM_DIR}/nvm.sh"
  nvm install --no-progress "$NODE_VERSION"
fi

which node && node -v || echo "node not found, PATH=$PATH"
which npm && npm -v || echo "npm not found, PATH=$PATH"
