// Declarar os comandos aqui faz o Tauri gerar as permissões `allow-<comando>`.
// Comandos não declarados e não listados em capabilities/ ficam inacessíveis ao WebView.
const COMMANDS: &[&str] = &[
    "auth_token_get",
    "auth_token_set",
    "auth_token_clear",
    "set_close_to_tray",
    "notify",
    "play_list_windows",
    "play_arm",
    "play_input",
    "play_disarm",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("falha no tauri-build");
}
