# Working on this repo

## Branches
`main` is protected. Work on `feat/…`, `fix/…`, `chore/…` and open a pull request.

## Before every commit
```bash
npm run typecheck     # tsc --noEmit
npm run test:i18n     # fails if the ar/en dictionaries diverge
git status            # confirm no certs/ or .env is staged
```

A missing i18n key renders as a blank element — silent and easy to ship. The parity check
exists to catch exactly that.

## Commit style
```
feat(cards): 7-step creation wizard
fix(apns): reuse the HTTP/2 session across broadcasts
docs(build): record the measured strip-cache numbers
```
