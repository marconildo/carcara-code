# Task 6 Report — i18n fixes

## Fixes Applied

### Fix 1 — Preview log EN values (Important)
`src/lib/locales/en.json` — four `preview` keys had Portuguese text as their English values. Corrected:
- `log_restarting`: `"> restarting server...\n"`
- `log_preparing`: `"> preparing preview...\n"`
- `log_exited`: `"\n> server exited. See the error above.\n"`
- `log_found`: `"\n> server already started, looking for port...\n"`

`pt.json` was NOT modified for these keys (values remain Portuguese).

### Fix 2 — GitPanel toast strings (Important)
`t` from `useT()` confirmed in scope at `GitPanel` function body (line 76).

Added 7 keys to `git` namespace in both `en.json` and `pt.json`:
- `toast_init`, `toast_remote`, `toast_pull`, `toast_push`, `toast_checkout`, `toast_commit`, `toast_pushed`

Replaced 8 hardcoded PT `okMsg` strings in `src/components/GitPanel.jsx` with `t(...)` calls.

### Fix 3 — Bare 'Terminal' fallback (Minor)
Added `preview.terminal_bare: "Terminal"` to both `en.json` and `pt.json`.
Replaced bare `'Terminal'` at `PreviewPanel.jsx` line 748 with `t('preview.terminal_bare')`.

### Fix 4 — UTF-8 BOM (Minor)
`src/components/CheckpointsPanel.jsx` had a leading BOM (bytes EF BB BF).
Stripped via `[System.IO.File]::ReadAllBytes` / `WriteAllBytes` without touching any other content.

## Verification Outputs

### i18n parity smoke
```
$ node scripts/i18n-parity.smoke.cjs
i18n parity ok
```

### npm run build
```
vite v8.0.16 building client environment for production...
4799 modules transformed.
built in 1.38s
```
No errors.

### grep for old PT toasts
```
$ grep -n "Pull concluido|Push concluido|Repositorio criado|Commit feito|Enviado pro GitHub|Remoto conectado" src/components/GitPanel.jsx
(no output — all migrated)
```

### BOM check
Bytes before fix: 239 187 191 (EF BB BF = UTF-8 BOM)
After fix: BOM removed, file starts directly with `import`.
