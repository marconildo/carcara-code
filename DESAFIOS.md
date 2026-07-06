# Desafios

## PATH em app GUI no macOS

Apps Electron no macOS não herdam o PATH dos dotfiles (`.zshrc`). O pty agora abre
como login shell (`zsh -l`, via `platform.loginArgsFor()`), e o boot chama `fix-path`
(ver Task 4). Gotcha: `fix-path`/`shell-env` falham SILENCIOSAMENTE com shells
não-POSIX (Fish, Nushell), caindo no PATH mínimo — raro no público-alvo, mas se um
usuário reportar "claude não encontrado" no Mac com shell exótico, é isto.
