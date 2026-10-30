<img src="assets/icon.svg" width="64" height="64" alt="">

# salespatriot

Created in [T3 Code](https://t3.codes).

## Development

pnpm workspace with apps in `apps/*` and shared packages in `packages/*`.

```sh
pnpm install
pnpm build      # also: dev, test, typecheck (run across packages by Turborepo)
pnpm lint       # oxlint, type-aware; lint:fix to autofix
pnpm fmt        # oxfmt; fmt:check to verify only
```

New TypeScript packages extend `@salespatriot/typescript-config/base.json`.
