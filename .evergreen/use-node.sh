if [[ "$OS" == "Windows_NT" ]]; then
    export PATH="$PWD/.deps/node/bin:$PATH"
else
    # so we use the devtools binaries first (for gcc/g++)
    export PATH="/opt/devtools/bin:$PATH"

    if [ uname = "Darwin" ] ; then
	export NVM_DIR="$PWD/.deps/nvm"
	[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
    else
	NODE_MAJOR=$(echo $NODE_VERSION | awk -F . '{print $1}')
	export PATH="/opt/devtools/node$NODE_MAJOR/bin:$PATH"
    fi
fi

echo "updated PATH=$PATH"
