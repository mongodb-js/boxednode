# 📦 boxednode – Ship a JS file with Node.js in a box

Take

1. A JavaScript file
2. Node.js

and pack them up as a single binary.

For example:

```sh
$ cat example.js
console.log('Hello, world!');
$ boxednode -s example.js -t example
$ ./example
Hello, world!
```

## CLI usage

```sh
Options:
      --version         Show version number                            [boolean]
  -c, --clean           Clean up temporary directory after success     [boolean]
  -s, --source          Source .js file                      [string] [required]
  -t, --target          Target executable file               [string] [required]
  -n, --node-version    Node.js version or semver version range
                                                         [string] [default: "*"]
  -C, --configure-args  Extra ./configure or vcbuild arguments, comma-separated
                                                                        [string]
  -M, --make-args       Extra make or vcbuild arguments, comma-separated[string]
      --tmpdir          Temporary directory for compiling Node.js source[string]
      --help            Show help                                      [boolean]
```

## Programmatic API

```js
type CompilationOptions = {
  // Single Node.js version or semver range to pick from
  nodeVersionRange: string;

  // Optional temporary directory for storing and compiling Node.js source
  tmpdir?: string;

  // A single .js file that serves as the entry point for the generated binary
  sourceFile: string;

  // The file path to the target binary
  targetFile: string;

  // Optional list of extra arguments to be passed to `./configure` or `vcbuild`
  configureArgs?: string[],

    // Optional list of extra arguments to be passed to `make` or `vcbuild`
  makeArgs?: string[],

  // If true, remove the temporary directory created earlier when done
  clean?: boolean;
};

export function compileJSFileAsBinary(options: CompilationOptions);
```

The `BOXEDNODE_CONFIGURE_ARGS` environment variable will be read as a
comma-separated list of strings and added to `configureArgs`, and likewise
`BOXEDNODE_MAKE_ARGS` to `makeArgs`.

## Why this solution

We needed a simple and reliable way to create shippable binaries from a source
file.

Unlike others, this solution:

- Works for Node.js v12.x and above, without being tied to specific versions
- Uses only officially supported, stable Node.js APIs
- Creates binaries that are not bloated with extra features
- Creates binaries that can be signed and notarized on macOS

## Prerequisites

This package compiles Node.js from source. See the Node.js
[BUILDING.md file](https://github.com/nodejs/node/blob/master/BUILDING.md) for
a complete list of tools that may be necessary.

## Not supported

- Native addons
- Multiple JS files

## Similar projects

- [pkg](https://www.npmjs.com/package/pkg)
- [nexe](https://www.npmjs.com/package/nexe)

## License

[Apache-2.0](./LICENSE)
