# Security Policy

Report security issues privately.

## How to report

- Email: rxova@proton.me
- [GitHub security advisory form](https://github.com/rxova/ts-extended-errors/security/advisories/new)

If the advisory form is unavailable, use email. Include the affected version, a minimal
reproduction and the impact. Public disclosure should wait until a fix is released.

## Supported versions

Fixes land on the current minor and ship as a patch. Older minors are not backported.

## Scope notes

`deserializeError` builds errors from input that may be untrusted, and `serializeError` with
`includeOwnProperties: true` copies fields from the errors it is given. Reports about either are in
scope. Choosing a class by the payload's `name`, limited to the built-in error classes and the ones
passed in `classes`, is the documented behaviour.
