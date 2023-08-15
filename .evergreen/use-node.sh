if [[ "$OS" == "Windows_NT" ]]; then
  export PATH="$PWD/.deps/node/bin:$PATH"
else
  export NVM_DIR="$PWD/.deps/nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
fi

echo "updated PATH=$PATH"
