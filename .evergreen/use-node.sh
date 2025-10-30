if [[ "$OS" == "Windows_NT" ]]; then
    export PATH="$PWD/.deps/node/bin:$PATH"
else
    # so we use the devtools binaries first (for gcc/g++)
    export PATH="/opt/devtools/bin:$PATH"

    if [ uname = "Darwin" ] ; then # in OSX use nvm
	export NVM_DIR="$PWD/.deps/nvm"
	[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
    else # In Linux, use .deps/node/bin because it was set up with symlink to an existing node in the toolchain
	export PATH="$PWD/.deps/node/bin:$PATH"
    fi
fi

echo "updated PATH=$PATH"
