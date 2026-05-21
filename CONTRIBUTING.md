# Contributing

Thanks for your interest in contributing to the WAX RNG Oracle! Contributions of
all kinds are welcome — bug reports, documentation, tests, and code.

## Getting started

```bash
# Install dependencies
npm install

# Build (webpack, development mode)
npm run build

# Run unit tests (no external dependencies — this is what CI runs)
npm run test:unit

# Run integration tests (require Docker; spin up a WAX chain via qtest-js)
npm run test:integration

# Run the full suite (unit + integration)
npm test

# Format code before committing
npm run prettier
```

The **integration tests** (`test:integration`) start a local WAX chain in
Docker through [`qtest-js`](https://www.npmjs.com/package/qtest-js), so they
require a working Docker daemon and are not run in CI. CI runs `npm run
test:unit` plus `npm run lint`; please make sure both pass before opening a pull
request. See the [README](README.md) for configuration and local development
details.

## Reporting issues

- Search existing issues first to avoid duplicates.
- For bugs, include reproduction steps, expected vs. actual behavior, and your
  environment (Node version, OS, network/chain).
- **Security issues:** please do **not** open a public issue. Disclose
  vulnerabilities privately — see the security policy / contact below.

## Pull requests

1. Fork the repository and create a topic branch from the default branch.
2. Keep changes focused; one logical change per PR.
3. Add or update tests for any behavior change.
4. Ensure `npm test` and `npm run lint` pass.
5. Never commit secrets (private keys, mnemonics, tokens) or environment-specific
   configuration with real values. Configuration is supplied via environment
   variables — see the README.
6. Write a clear PR description explaining the motivation and approach.

## Blockchain interaction

Changes to on-chain interaction logic (the `orng.wax` contract actions:
`setrand`, `signepoch`, `execjob`, etc.) require extra scrutiny. Please describe
the expected on-chain behavior and how you verified it.

## Developer Certificate of Origin (DCO)

By contributing, you certify that you wrote the code or otherwise have the right
to submit it under the project's license, per the
[Developer Certificate of Origin](https://developercertificate.org/). Sign off
your commits with:

```bash
git commit -s -m "Your message"
```

## License

This project is licensed under the [MIT License](LICENSE). By contributing, you
agree that your contributions will be licensed under the same terms (inbound =
outbound).
