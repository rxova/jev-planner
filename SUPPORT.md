# Support

- **Bug?** Open an [issue](https://github.com/rxova/ts-extended-errors/issues/new).
- **Idea or missing feature?** Open an [issue](https://github.com/rxova/ts-extended-errors/issues/new).
- **Security issue?** Follow [SECURITY.md](./SECURITY.md). Do not open a public issue.
- **Something private?** Email [rxova@proton.me](mailto:rxova@proton.me).

Before filing, check the [README](packages/ts-extended-errors/README.md). It has an example for
every export, and each output comment is the value that example prints.

## Filing a good bug

- The package version, and whether the code loads it as ESM or CommonJS.
- The runtime and its version: Node.js, a browser, a worker.
- For serialization: the object `serializeError` produced, and the `classes` passed to
  `deserializeError`.
- For an `instanceof` that is `false`: where the class is defined, and whether two copies of the
  package are installed (`npm ls ts-extended-errors`).

## Version support

Fixes target the latest minor. Older minors are not maintained in parallel. Before 1.0, a minor
version may contain breaking changes; the changelog lists each one.
