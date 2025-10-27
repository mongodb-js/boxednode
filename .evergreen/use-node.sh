if [[ "$OS" == "Windows_NT" ]]; then
    export PATH="$PWD/.deps/node/bin:$PATH"
else
    # so we use the devtools binaries first (for gcc/g++)
    export PATH="/opt/devtools/bin:$PATH"
    export NVM_DIR="$PWD/.deps/nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
fi

echo "updated PATH=$PATH"
