# Repeatable fixture project

This fixture generator creates a local git repository with:

- unrelated dirty file changes
- untracked files
- protected paths
- an untrusted fake instruction file
- a wrong-model temptation file for `forbidden-model`
- explicit test and proof commands

Commands:

```bash
npm run fixture:create
npm run fixture:test
npm run fixture:proof
```
